const express = require("express")
const router = express.Router()
const { createClient } = require("@supabase/supabase-js")
const { createClient: createSanityClient } = require("@sanity/client")
const axios = require("axios")
const postmark = require("postmark")
const nodemailer = require("nodemailer")

// Gmail SMTP transporter for Plateau United emails
const gmailTransporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
})

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY
const PAYSTACK_BASE_URL = "https://api.paystack.co"

// Supabase setup
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_ANON_KEY
const supabase = createClient(supabaseUrl, supabaseKey)

// Sanity setup
const sanityClient = createSanityClient({
  projectId: '252rx5c8',
  dataset: 'production',
  apiVersion: '2023-05-03',
  useCdn: false, // Set to false to get fresh data
})

// Postmark setup
const postmarkClient = new postmark.ServerClient(process.env.POSTMARK_SERVER_TOKEN)

// Initialize shop payment
router.post("/shop/initialize-payment", async (req, res) => {
  try {
    const { 
      email, 
      firstName, 
      lastName, 
      phone, 
      items, 
      deliveryAddress,
      discountCode,
      callbackUrl 
    } = req.body

    console.log("Received shop payment initialization:", { email, items, discountCode })

    if (!items || !items.length) {
      return res.status(400).json({ error: "Cart is empty" })
    }

    // 1. Fetch current prices from Sanity to prevent price tampering
    const productIds = items.map(item => `"${item.id}"`).join(",")
    const query = `*[_type == "product" && _id in [${productIds}]]{ _id, price, name }`
    const sanityProducts = await sanityClient.fetch(query)

    let subtotal = 0
    const verifiedItems = items.map(item => {
      const sanityProduct = sanityProducts.find(p => p._id === item.id)
      if (!sanityProduct) {
        throw new Error(`Product ${item.id} not found in Sanity`)
      }
      const price = parseFloat(sanityProduct.price)
      subtotal += price * item.quantity
      return {
        ...item,
        price, // Use price from Sanity
        name: sanityProduct.name
      }
    })

    // 2. Calculate Delivery Fee (Security: recalculate on server)
    let deliveryFee = 0

    if (req.body.selectedState) {
      if (req.body.isJos) {
        deliveryFee = 1500
      } else if (req.body.selectedState === "Plateau") {
        deliveryFee = 3000
      } else {
        deliveryFee = 5000
      }
    }


    // 3. Apply discount if code matches: 2 letters + 3 numbers
    let discountApplied = 0
    let discountIsValid = false
    if (discountCode && /^[a-zA-Z]{2}\d{3}$/.test(discountCode)) {
      discountIsValid = true
      discountApplied = subtotal * 0.1
    }

    const totalAmount = subtotal - discountApplied + deliveryFee

    // 4. Initialize Paystack
    const response = await axios.post(
      `${PAYSTACK_BASE_URL}/transaction/initialize`,
      {
        email,
        amount: Math.round(totalAmount * 100), // Kobo
        channels: ["card", "bank", "apple_pay", "ussd", "qr", "mobile_money", "bank_transfer", "eft", "payattitude"],
        callback_url: callbackUrl,
        metadata: {
          payment_type: "shop_merch",
          items: verifiedItems,
          delivery_address: deliveryAddress,
          delivery_fee: deliveryFee,
          selected_state: req.body.selectedState
        }
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    )

    // 5. Save to Supabase (shop_payments table)
    const paymentData = {
      email,
      first_name: firstName,
      last_name: lastName,
      phone,
      items: verifiedItems,
      subtotal,
      delivery_fee: deliveryFee,
      discount_applied: discountApplied,
      total_amount: totalAmount,
      payment_reference: response.data.data.reference,
      payment_status: "pending",
      delivery_address: deliveryAddress,
      discount_code: discountIsValid ? discountCode : null,
      delivery_metadata: {
        selected_state: req.body.selectedState,
        is_jos: req.body.isJos
      }
    }

    const { error: supabaseError } = await supabase
      .from("shop_payments")
      .insert([paymentData])

    if (supabaseError) {
      console.error("CRITICAL: Supabase Insert Failed:", {
        message: supabaseError.message,
        details: supabaseError.details,
        hint: supabaseError.hint,
        code: supabaseError.code,
        data_attempted: paymentData
      });
      return res.status(500).json({ 
        error: "Failed to record order in database. Your payment was not processed.", 
        details: supabaseError.message 
      });
    }

    res.json(response.data)
  } catch (error) {
    console.error("Shop payment initialization failed:", error.message)
    res.status(500).json({ error: "Failed to initialize shop payment", details: error.message })
  }
})

// Newsletter subscription
router.post("/newsletter/subscribe", async (req, res) => {
  try {
    const { email } = req.body

    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Valid email is required" })
    }

    const { data, error } = await supabase
      .from("newsletter_subscriptions")
      .insert([{ email }])

    if (error) {
      if (error.code === '23505') { // Unique violation
        return res.status(400).json({ error: "This email is already subscribed!" })
      }
      throw error
    }

    res.json({ success: true, message: "Subscribed successfully!" })
  } catch (error) {
    console.error("Newsletter subscription failed:", error.message)
    res.status(500).json({ error: "Failed to subscribe. Please try again later." })
  }
})

// Verify shop payment
router.get("/shop/verify-payment/:reference", async (req, res) => {
  try {
    const { reference } = req.params
    console.log("Verifying shop payment for reference:", reference)

    const response = await axios.get(`${PAYSTACK_BASE_URL}/transaction/verify/${reference}`, {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    })

    const paystackData = response.data.data
    const paymentStatus = paystackData.status

    let dbStatus = "pending"
    if (paymentStatus === "success") dbStatus = "completed"
    else if (paymentStatus === "failed") dbStatus = "failed"

    // Update status in Supabase
    const { data: updateData, error: updateError } = await supabase
      .from("shop_payments")
      .update({ payment_status: dbStatus })
      .eq("payment_reference", reference)
      .select()
      .single()

    if (updateError) {
      console.error("Error updating shop payment status:", updateError)
      return res.status(updateError.code === 'PGRST116' ? 404 : 500).json({ 
        error: "Order record not found or update failed.", 
        details: updateError.message 
      })
    }

    if (paymentStatus === "success" && updateData) {
      console.log("Shop payment successful for:", updateData.email)
      // Send email notification to admin
      await sendShopOrderAdminEmail(updateData)
    }

    res.json({
      status: dbStatus,
      message: `Payment ${dbStatus}`,
      paymentDetails: paystackData
    })
  } catch (error) {
    console.error("Shop payment verification failed:", error.message)
    res.status(500).json({ error: "Failed to verify shop payment", details: error.message })
  }
})

async function sendShopOrderAdminEmail(paymentData) {
  const adminEmail = process.env.ADMIN_EMAIL || "bookings@experienceplateau.com"
  
  const itemsHtml = paymentData.items.map(item => `
    <tr>
      <td style="padding: 10px; border-bottom: 1px solid #eee;">${item.name}</td>
      <td style="padding: 10px; border-bottom: 1px solid #eee;">${item.size}</td>
      <td style="padding: 10px; border-bottom: 1px solid #eee;">${item.color || 'N/A'}</td>
      <td style="padding: 10px; border-bottom: 1px solid #eee;">${item.quantity}</td>
      <td style="padding: 10px; border-bottom: 1px solid #eee;">₦${parseFloat(item.price).toLocaleString()}</td>
    </tr>
  `).join('')

  const emailHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px; }
        .header { background-color: #141E03; color: white; padding: 20px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { padding: 20px; }
        .total-section { margin-top: 20px; border-top: 2px solid #141E03; padding-top: 10px; }
        .detail-row { margin-bottom: 10px; }
        .label { font-weight: bold; color: #141E03; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th { background-color: #f8f8f8; padding: 10px; text-align: left; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>New Shop Order Received!</h1>
        </div>
        <div class="content">
          <p>A new order has been placed on the Experience Plateau Shop.</p>
          
          <h2>Order Details</h2>
          <div class="detail-row"><span class="label">Customer:</span> ${paymentData.first_name} ${paymentData.last_name}</div>
          <div class="detail-row"><span class="label">Email:</span> ${paymentData.email}</div>
          <div class="detail-row"><span class="label">Phone:</span> ${paymentData.phone}</div>
          <div class="detail-row"><span class="label">Delivery Address:</span> ${paymentData.delivery_address}</div>
          <div class="detail-row"><span class="label">Payment Reference:</span> ${paymentData.payment_reference}</div>
          
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Size</th>
                <th>Color</th>
                <th>Qty</th>
                <th>Price</th>
              </tr>
            </thead>
            <tbody>
              ${itemsHtml}
            </tbody>
          </table>
          
          <div class="total-section">
            <div class="detail-row"><span class="label">Subtotal:</span> ₦${parseFloat(paymentData.subtotal).toLocaleString()}</div>
            ${paymentData.delivery_fee > 0 ? `<div class="detail-row"><span class="label">Shipping:</span> ₦${parseFloat(paymentData.delivery_fee).toLocaleString()}</div>` : ''}
            ${paymentData.discount_applied > 0 ? `<div class="detail-row"><span class="label">Discount:</span> -₦${parseFloat(paymentData.discount_applied).toLocaleString()} (${paymentData.discount_code})</div>` : ''}
            <div class="detail-row" style="font-size: 18px; margin-top: 10px;"><span class="label">Total Amount Paid:</span> ₦${parseFloat(paymentData.total_amount).toLocaleString()}</div>
          </div>
          
          <p style="margin-top: 30px; font-size: 12px; color: #777; text-align: center;">
            Order ID: ${paymentData.id}<br>
            Timestamp: ${new Date().toLocaleString()}
          </p>
        </div>
      </div>
    </body>
    </html>
  `

  try {
    await postmarkClient.sendEmail({
      From: process.env.EMAIL_FROM || "bookings@experienceplateau.com",
      To: adminEmail,
      Subject: `New Shop Order Received – ${paymentData.first_name} ${paymentData.last_name}`,
      HtmlBody: emailHTML,
      MessageStream: "outbound"
    })
    console.log("Shop order admin notification email sent successfully")
  } catch (error) {
    console.error("Error sending shop order admin notification email:", error)
  }
}

// ─── Lint Payment Integration ─────────────────────────────────────────────────

const LINT_BASE_URL = process.env.LINT_BASE_URL || "https://develop.lint.finance"

// In-memory token cache — survives across requests within one server instance
let lintTokenCache = { token: null, expiresAt: 0 }

async function getLintToken() {
  if (lintTokenCache.token && Date.now() < lintTokenCache.expiresAt) {
    console.log("Lint: using cached token")
    return lintTokenCache.token
  }
  console.log("Lint: fetching token from", `${LINT_BASE_URL}/oauth/token`)
  console.log("Lint: client_id present:", !!process.env.LINT_CLIENT_ID, "| client_secret present:", !!process.env.LINT_CLIENT_SECRET)
  try {
    const { data } = await axios.post(`${LINT_BASE_URL}/oauth/token`, {
      grant_type: "client_credentials",
      client_id: process.env.LINT_CLIENT_ID,
      client_secret: process.env.LINT_CLIENT_SECRET,
      scope: "",
    }, { headers: { "Content-Type": "application/json", Accept: "application/json" } })
    console.log("Lint: token fetched OK, token_type:", data.token_type, "| expires_in:", data.expires_in)
    lintTokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + 55 * 60 * 1000,
    }
    return data.access_token
  } catch (e) {
    console.error("Lint: token fetch FAILED:", e.response?.status, JSON.stringify(e.response?.data))
    throw e
  }
}

function lintHeaders(token) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" }
}

// ─── Plateau United Routes ───────────────────────────────────────────────────

const PU_PRICES = {
  "Home Kit":          { fan: 15000, player: 30000 },
  "Away Kit":          { fan: 15000, player: 30000 },
  "Alternate Kit":     { fan: 15000, player: 30000 },
  "Fwavei":            30000,
  "Farin Gada":        30000,
  "Terminus":          30000,
  "Hoodie":            35000,
  "Tracksuit":         35000,
}

const PU_DELIVERY_FEES = {
  A: 1500, B: 2000, C: 2500, D: 3000, E: 3750,
  interstate: 0,
}

router.post("/plateau-united/initialize-payment", async (req, res) => {
  try {
    const {
      email, firstName, lastName, phone,
      kitName, size, gender, quality, quantity,
      fulfillmentType,
      deliveryAddress, deliveryZone, deliveryFee, isInterstate,
    } = req.body

    const isPickup = fulfillmentType === "pickup"

    // Server-side price verification
    if (!PU_PRICES[kitName]) {
      return res.status(400).json({ error: "Invalid kit selected" })
    }
    const priceEntry = PU_PRICES[kitName]
    const unitPrice = typeof priceEntry === "object"
      ? (quality === "Player grade" ? priceEntry.player : priceEntry.fan)
      : priceEntry
    const qty = Math.max(1, parseInt(quantity) || 1)

    // Server-side delivery fee verification
    let zoneFee = 0
    if (!isPickup) {
      zoneFee = isInterstate ? 0 : (PU_DELIVERY_FEES[deliveryZone] ?? null)
      if (!isInterstate && zoneFee === null) {
        return res.status(400).json({ error: "Invalid delivery zone" })
      }
      if (!isInterstate && zoneFee !== parseInt(deliveryFee)) {
        return res.status(400).json({ error: "Delivery fee mismatch" })
      }
    }

    const totalAmount = unitPrice * qty + (isPickup ? 0 : (isInterstate ? 0 : zoneFee))

    // Generate a unique reference
    const reference = `PU-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

    // Create Lint virtual account
    const token = await getLintToken()
    const callbackUrl = `${process.env.SERVER_URL || "https://exp-server2-seven.vercel.app"}/api/plateau-united/lint-webhook`
    const vaPayload = { amount: totalAmount * 100, currency: "NGN", reference, callback_url: callbackUrl, amount_control: "FIXED", validity: 3600 }
    console.log("Lint: creating virtual account →", JSON.stringify(vaPayload))

    let lintData
    try {
      const res2 = await axios.post(
        `${LINT_BASE_URL}/api/partner/v1/payments/virtual-accounts`,
        vaPayload,
        { headers: lintHeaders(token) }
      )
      lintData = res2.data
      console.log("Lint: virtual account created →", JSON.stringify(lintData))
    } catch (e) {
      console.error("Lint: virtual account creation FAILED:", e.response?.status, JSON.stringify(e.response?.data))
      throw e
    }

    const account = lintData.data

    // Save order to Supabase — store Lint account id as payment_reference for lookup
    const { error: supabaseError } = await supabase
      .from("plateau_united_orders")
      .insert([{
        email,
        first_name: firstName,
        last_name: lastName,
        phone,
        kit_name: kitName,
        size,
        gender: gender || null,
        quality: quality || null,
        quantity: qty,
        unit_price: unitPrice,
        fulfillment_type: isPickup ? "pickup" : "delivery",
        delivery_fee: isPickup ? 0 : (isInterstate ? 0 : zoneFee),
        delivery_zone: isPickup ? null : (isInterstate ? "interstate" : deliveryZone),
        delivery_address: isPickup ? null : deliveryAddress,
        is_interstate: isPickup ? false : !!isInterstate,
        total_amount: totalAmount,
        payment_reference: account.id,   // Lint virtual account UUID
        lint_reference: reference,        // our generated reference string
        payment_status: "pending",
      }])

    if (supabaseError) {
      console.error("Supabase PU insert failed:", supabaseError)
      return res.status(500).json({ error: "Failed to record order", details: supabaseError.message })
    }

    res.json({ data: account })
  } catch (error) {
    const detail = error.response?.data || error.message
    console.error("PU payment init failed:", detail)
    res.status(500).json({ error: "Failed to initialize payment", details: detail })
  }
})

// Poll payment status (called by frontend "I've made the transfer" button)
router.get("/plateau-united/verify-payment/:accountId", async (req, res) => {
  try {
    const { accountId } = req.params

    const token = await getLintToken()
    const { data: lintData } = await axios.get(
      `${LINT_BASE_URL}/api/partner/v1/payments/virtual-accounts/${accountId}/payment-status`,
      { headers: lintHeaders(token) }
    )

    const lintStatus = lintData.data.payment_status // "PENDING" | "SUCCESSFUL" | "FAILED"
    const dbStatus = lintStatus === "SUCCESSFUL" ? "completed" : lintStatus === "FAILED" ? "failed" : "pending"

    // Update order only when status changes to terminal state
    if (lintStatus === "SUCCESSFUL" || lintStatus === "FAILED") {
      const { data: order, error: updateError } = await supabase
        .from("plateau_united_orders")
        .update({ payment_status: dbStatus })
        .eq("payment_reference", accountId)
        .select()
        .single()

      if (!updateError && order && lintStatus === "SUCCESSFUL") {
        await sendPUCustomerEmail(order)
        await sendPUAdminEmail(order)
      }
    }

    res.json({ payment_status: lintStatus, status: dbStatus })
  } catch (error) {
    const detail = error.response?.data || error.message
    console.error("PU payment verify failed:", detail)
    res.status(500).json({ error: "Failed to verify payment", details: detail })
  }
})

// Lint webhook — receives push notifications when payment completes
router.post("/plateau-united/lint-webhook", async (req, res) => {
  try {
    const event = req.body
    console.log("Lint webhook received:", JSON.stringify(event))

    // Lint sends the virtual account object with payment_status
    const lintStatus = event?.payment_status || event?.data?.payment_status
    const accountId = event?.id || event?.data?.id

    if (lintStatus === "SUCCESSFUL" && accountId) {
      const { data: order, error } = await supabase
        .from("plateau_united_orders")
        .update({ payment_status: "completed" })
        .eq("payment_reference", accountId)
        .eq("payment_status", "pending") // idempotency guard
        .select()
        .single()

      if (!error && order) {
        await sendPUCustomerEmail(order)
        await sendPUAdminEmail(order)
        console.log("PU webhook: order fulfilled for", order.email)
      }
    }

    res.json({ received: true })
  } catch (error) {
    console.error("Lint webhook error:", error.message)
    res.status(500).json({ error: "Webhook processing failed" })
  }
})

async function sendPUCustomerEmail(order) {
  const isPickup = order.fulfillment_type === "pickup"

  const fulfillmentNote = isPickup
    ? `<p style="background:#f0fdf4;border:1px solid #bbf7d0;padding:12px;border-radius:6px;"><strong>🏟 Pickup Order</strong> — Please collect your order at: <strong>No. 6, Amazing Grace House, Shok Bature Street, off Peter Gyang Sha Road, from Rayfield Golf Club, Rayfield, Jos.</strong> Our team will confirm pickup timing via WhatsApp (${order.phone}).</p>`
    : order.is_interstate
      ? `<p style="background:#fff8e1;border:1px solid #ffe082;padding:12px;border-radius:6px;"><strong>⭐ Manual Dispatch</strong> — Our team will contact you on WhatsApp (${order.phone}) to arrange interstate delivery.</p>`
      : `<p><strong>Delivery Zone:</strong> Zone ${order.delivery_zone} — expect delivery within 1–3 business days via Bamjiye.</p>`

  const html = `
    <!DOCTYPE html><html><body style="font-family:Arial,sans-serif;color:#333;">
    <div style="max-width:600px;margin:0 auto;border:1px solid #eee;border-radius:10px;overflow:hidden;">
      <div style="background:#1A6B2C;padding:24px;text-align:center;">
        <h1 style="color:#F7D000;margin:0;">Order Confirmed!</h1>
        <p style="color:#fff;margin:8px 0 0;">Plateau United Official Merchandise</p>
      </div>
      <div style="padding:24px;">
        <p>Hi ${order.first_name}, your order has been confirmed and payment received.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;">
          <tr style="background:#f8f8f8;">
            <th style="padding:10px;text-align:left;">Item</th>
            <th style="padding:10px;text-align:left;">Details</th>
            <th style="padding:10px;text-align:left;">Amount</th>
          </tr>
          <tr>
            <td style="padding:10px;border-bottom:1px solid #eee;"><strong>${order.kit_name}</strong></td>
            <td style="padding:10px;border-bottom:1px solid #eee;">Size: ${order.size} &nbsp;|&nbsp; Qty: ${order.quantity}</td>
            <td style="padding:10px;border-bottom:1px solid #eee;">₦${order.unit_price.toLocaleString()}</td>
          </tr>
          ${!isPickup && order.delivery_fee > 0 ? `<tr><td style="padding:10px;border-bottom:1px solid #eee;">Delivery (Zone ${order.delivery_zone})</td><td></td><td style="padding:10px;border-bottom:1px solid #eee;">₦${order.delivery_fee.toLocaleString()}</td></tr>` : ""}
          <tr style="background:#f8f8f8;">
            <td style="padding:10px;" colspan="2"><strong>Total Paid</strong></td>
            <td style="padding:10px;"><strong>₦${order.total_amount.toLocaleString()}</strong></td>
          </tr>
        </table>
        ${!isPickup && order.delivery_address ? `<p><strong>Delivery Address:</strong> ${order.delivery_address}</p>` : ""}
        ${fulfillmentNote}
        <p><strong>Reference:</strong> <code>${order.lint_reference || order.payment_reference}</code></p>
        <p style="margin-top:24px;color:#555;">For enquiries contact <a href="mailto:Plateauunitedsales@gmail.com">Plateauunitedsales@gmail.com</a> or reply to this email.</p>
        <p style="margin-top:8px;font-size:11px;color:#999;">Official merchandise by Galaxy × Experience Plateau × Plateau United FC</p>
      </div>
    </div>
    </body></html>
  `
  try {
    await gmailTransporter.sendMail({
      from: `"Plateau United" <${process.env.GMAIL_USER}>`,
      to: order.email,
      subject: `Your Plateau United ${order.kit_name} Order is Confirmed!`,
      html,
    })
    console.log("PU customer email sent via Gmail to", order.email)
  } catch (e) {
    console.error("PU customer email failed:", e)
  }
}

async function sendPUAdminEmail(order) {
  const isPickup = order.fulfillment_type === "pickup"

  const dispatchFlag = isPickup
    ? `<p style="background:#f0fdf4;border:1px solid #bbf7d0;padding:12px;"><strong>🏟 PICKUP ORDER</strong> — Customer will collect. Contact on WhatsApp: ${order.phone}</p>`
    : order.is_interstate
      ? `<p style="background:#fff8e1;border:1px solid #ffe082;padding:12px;"><strong>⭐ INTERSTATE ORDER — Manual dispatch required.</strong> Contact customer on WhatsApp: ${order.phone}</p>`
      : `<p><strong>Delivery Zone:</strong> Zone ${order.delivery_zone} — Bamjiye</p>`

  const html = `
    <!DOCTYPE html><html><body style="font-family:Arial,sans-serif;color:#333;">
    <div style="max-width:600px;margin:0 auto;border:1px solid #eee;border-radius:10px;overflow:hidden;">
      <div style="background:#141E03;padding:24px;text-align:center;">
        <h1 style="color:#F7D000;margin:0;">New Plateau United Order</h1>
        <p style="color:#aaa;margin:4px 0 0;">Payment Confirmed via Lint</p>
      </div>
      <div style="padding:24px;">
        ${dispatchFlag}
        <p><strong>Customer:</strong> ${order.first_name} ${order.last_name}</p>
        <p><strong>Email:</strong> ${order.email}</p>
        <p><strong>Phone / WhatsApp:</strong> ${order.phone}</p>
        <hr style="border:none;border-top:1px solid #eee;margin:16px 0;">
        <p><strong>Kit:</strong> ${order.kit_name}</p>
        <p><strong>Size:</strong> ${order.size}</p>
        <p><strong>Quantity:</strong> ${order.quantity}</p>
        <p><strong>Unit Price:</strong> ₦${order.unit_price.toLocaleString()}</p>
        ${!isPickup && order.delivery_fee > 0 ? `<p><strong>Delivery Fee:</strong> ₦${order.delivery_fee.toLocaleString()} (Zone ${order.delivery_zone})</p>` : ""}
        <p><strong>Total Paid:</strong> <strong style="font-size:18px;">₦${order.total_amount.toLocaleString()}</strong></p>
        <hr style="border:none;border-top:1px solid #eee;margin:16px 0;">
        ${!isPickup && order.delivery_address ? `<p><strong>Delivery Address:</strong> ${order.delivery_address}</p>` : `<p><strong>Fulfillment:</strong> Pickup</p>`}
        <p><strong>Lint Reference:</strong> <code>${order.lint_reference || order.payment_reference}</code></p>
        <p style="color:#777;font-size:12px;">Received: ${new Date().toLocaleString()}</p>
      </div>
    </div>
    </body></html>
  `
  try {
    await gmailTransporter.sendMail({
      from: `"Plateau United" <${process.env.GMAIL_USER}>`,
      to: process.env.GMAIL_USER,
      subject: `${isPickup ? "🏟 PICKUP — " : order.is_interstate ? "⭐ INTERSTATE — " : ""}New PU Order — ${order.first_name} ${order.last_name} (${order.kit_name})`,
      html,
    })
    console.log("PU admin email sent via Gmail")
  } catch (e) {
    console.error("PU admin email failed:", e)
  }
}

module.exports = router
