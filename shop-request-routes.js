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
const sanityProjectID = process.env.SANITY_PROJECT_ID
const sanityClient = createSanityClient({
  projectId: sanityProjectID,
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

    // 2. Apply discount if code is 5 digits
    let discountApplied = 0
    let totalAmount = subtotal
    if (discountCode && discountCode.length === 5) {
      discountApplied = subtotal * 0.1
      totalAmount = subtotal - discountApplied
    }

    // 3. Initialize Paystack
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
          delivery_address: deliveryAddress
        }
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    )

    // 4. Save to Supabase (shop_payments table)
    const paymentData = {
      email,
      first_name: firstName,
      last_name: lastName,
      phone,
      items: verifiedItems,
      subtotal,
      discount_applied: discountApplied,
      total_amount: totalAmount,
      payment_reference: response.data.data.reference,
      payment_status: "pending",
      delivery_address: deliveryAddress,
      discount_code: discountCode
    }

    const { error: supabaseError } = await supabase
      .from("shop_payments")
      .insert([paymentData])

    if (supabaseError) {
      console.error("Error saving shop payment to Supabase:", supabaseError)
    }

    res.json(response.data)
  } catch (error) {
    console.error("Shop payment initialization failed:", error.message)
    res.status(500).json({ error: "Failed to initialize shop payment", details: error.message })
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
