const express = require("express")
const router = express.Router()
const { createClient } = require("@supabase/supabase-js")
const { createClient: createSanityClient } = require("@sanity/client")
const axios = require("axios")
const postmark = require("postmark")

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

module.exports = router
