const express = require("express")
const router = express.Router()
const { createClient } = require("@supabase/supabase-js")
const postmark = require("postmark")
const axios = require("axios")

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseUrl.startsWith("http")) {
  console.error(" ERROR: SUPABASE_URL is missing or invalid. Current value")
  
}

if (!supabaseServiceKey) {
  console.error(" ERROR: SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY is missing")
}

const supabase = createClient(supabaseUrl, supabaseServiceKey)

const client = new postmark.ServerClient(process.env.POSTMARK_SERVER_TOKEN)

// Submit booking request
router.post("/booking-requests", async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      phoneNumber,
      packageType,
      travelerType,
      groupSize,
      travelDate,
      specificRequests,
      selectedGuideId,
      totalAmount,
      displayCurrency,
      displayAmount,
    } = req.body

    console.log(" Received booking request")
    console.log(" Full request body")

    const { data: bookingRequest, error: insertError } = await supabase
      .from("booking_requests")
      .insert([
        {
          first_name: firstName,
          last_name: lastName,
          email,
          phone_number: phoneNumber,
          package_type: packageType,
          traveler_type: travelerType,
          group_size: groupSize,
          travel_date: travelDate,
          specific_requests: specificRequests || "None",
          guide_id: selectedGuideId,
          estimated_amount: totalAmount,
           display_currency: displayCurrency || "NGN",
          display_amount: displayAmount || totalAmount,
          status: "pending",
        },
      ])
      .select()
      .single()

    if (insertError) {
      console.error(" Error inserting booking request:", {
        message: insertError.message,
        details: insertError.details || insertError.toString(),
        hint: insertError.hint || "",
        code: insertError.code || "",
      })
      return res.status(400).json({
        success: false,
        message: "Failed to create booking request. Please check server configuration.",
        error: insertError.message,
      })
    }

    console.log(" Booking request created")

    // Send admin notification email
    await sendAdminNotificationEmail(bookingRequest)

    // Send customer confirmation email
    await sendCustomerConfirmationEmail(bookingRequest)

    res.status(200).json({
      success: true,
      message: "Booking request submitted successfully",
      requestId: bookingRequest.id,
    })
  } catch (error) {
    console.error(" Error submitting booking request:", error)
    res.status(500).json({
      success: false,
      message: "Failed to submit booking request",
      error: error.message,
    })
  }
})

// Admin approval endpoint
router.post("/booking-requests/:id/approve", async (req, res) => {
  try {
    const { id } = req.params
    const { adminNotes } = req.body

    console.log(" Approving booking request")

    // Update booking request status
    const { data: bookingRequest, error: updateError } = await supabase
      .from("booking_requests")
      .update({
        status: "approved",
        admin_notes: adminNotes,
        approved_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single()

    if (updateError) {
      console.error(" Error updating booking request:", updateError)
      throw updateError
    }

    // Send approval email with payment link
    await sendApprovalEmail(bookingRequest)

    res.status(200).json({
      success: true,
      message: "Booking request approved successfully",
    })
  } catch (error) {
    console.error(" Error approving booking request:", error)
    res.status(500).json({
      success: false,
      message: "Failed to approve booking request",
      error: error.message,
    })
  }
})

// Admin rejection endpoint
router.post("/booking-requests/:id/reject", async (req, res) => {
  try {
    const { id } = req.params
    const { rejectionReason } = req.body

    console.log(" Rejecting booking request")

    // Update booking request status
    const { data: bookingRequest, error: updateError } = await supabase
      .from("booking_requests")
      .update({
        status: "rejected",
        rejection_reason: rejectionReason,
        rejected_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single()

    if (updateError) {
      console.error(" Error updating booking request:", updateError)
      throw updateError
    }

    // Send rejection email
    await sendRejectionEmail(bookingRequest)

    res.status(200).json({
      success: true,
      message: "Booking request rejected",
    })
  } catch (error) {
    console.error(" Error rejecting booking request:", error)
    res.status(500).json({
      success: false,
      message: "Failed to reject booking request",
      error: error.message,
    })
  }
})

// Payment initialization endpoint
router.post("/booking-requests/:id/initialize-payment", async (req, res) => {
  try {
    const { id } = req.params
    const { email, amount, metadata } = req.body

    console.log("Initializing payment for booking request")

    // Verify booking request exists and is approved
    const { data: bookingRequest, error: fetchError } = await supabase
      .from("booking_requests")
      .select("*")
      .eq("id", id)
      .single()

    if (fetchError || !bookingRequest) {
      return res.status(404).json({
        success: false,
        error: "Booking request not found",
      })
    }

    if (bookingRequest.status !== "approved") {
      return res.status(400).json({
        success: false,
        error: "Booking request must be approved before payment",
      })
    }

    // Initialize payment with Paystack
    const paystackResponse = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: amount * 100,
        metadata,
        callback_url: `${process.env.FRONTEND_URL || "https://www.experienceplateau.com"}/travel-booking/payment/${id}`,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      },
    )

    console.log(" Payment initialized successfully")

    res.status(200).json(paystackResponse.data)
  } catch (error) {
    console.error(" Error initializing payment:", error)
    res.status(500).json({
      success: false,
      error: "Failed to initialize payment",
    })
  }
})

// Payment verification endpoint
router.post("/booking-requests/:id/verify-payment", async (req, res) => {
  try {
    const { id } = req.params
    const { reference } = req.body

    console.log(" Verifying payment for booking request")

    // Verify payment with Paystack
    const paystackResponse = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      },
    })

    const paymentData = paystackResponse.data.data

    if (paymentData.status === "success") {
      // Update booking request status to paid
      const { data: bookingRequest, error: updateError } = await supabase
        .from("booking_requests")
        .update({
          status: "paid",
          payment_reference: reference,
          paid_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select()
        .single()

      if (updateError) {
        console.error(" Error updating booking request:", updateError)
        throw updateError
      }

      await sendPaymentConfirmationEmail(bookingRequest, reference)

      await sendAdminPaymentNotification(bookingRequest, reference, paymentData)

      console.log(" Payment verified and booking confirmed")

      res.status(200).json({
        status: "success",
        message: "Payment verified successfully",
        data: bookingRequest,
      })
    } else {
      res.status(400).json({
        status: paymentData.status,
        message: "Payment verification failed",
      })
    }
  } catch (error) {
    console.error(" Error verifying payment:", error)
    res.status(500).json({
      success: false,
      error: "Failed to verify payment",
    })
  }
})

router.get("/booking-requests/:id", async (req, res) => {
  try {
    const { id } = req.params

    console.log("Fetching booking request")

    const { data: bookingRequest, error } = await supabase.from("booking_requests").select("*").eq("id", id).single()

    if (error) {
      console.error(" Error fetching booking request:", error)
      throw error
    }

    if (!bookingRequest) {
      return res.status(404).json({
        success: false,
        message: "Booking request not found",
      })
    }

    res.status(200).json(bookingRequest)
  } catch (error) {
    console.error(" Error fetching booking request:", error)
    res.status(500).json({
      success: false,
      message: "Failed to fetch booking request",
      error: error.message,
    })
  }
})

// Email functions
async function sendAdminNotificationEmail(bookingRequest) {
  const approveLink = `${process.env.FRONTEND_URL || "https://www.experienceplateau.com"}/admin/booking-requests/${bookingRequest.id}/approve`
  const rejectLink = `${process.env.FRONTEND_URL || "https://www.experienceplateau.com"}/admin/booking-requests/${bookingRequest.id}/reject`

  const adminEmail = process.env.ADMIN_EMAIL || "bookings@experienceplateau.com"

  const emailHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #5A8E00; color: white; padding: 20px; text-align: center; }
        .content { background-color: #f9f9f9; padding: 20px; }
        .detail-row { margin: 10px 0; }
        .detail-label { font-weight: bold; color: #5A8E00; }
        .action-buttons { margin: 30px 0; text-align: center; }
        .button { display: inline-block; padding: 12px 30px; margin: 10px; text-decoration: none; border-radius: 5px; font-weight: bold; }
        .approve-btn { background-color: #97E12B; color: #141E03; }
        .reject-btn { background-color: #dc3545; color: white; }
        .reminder { background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>New Booking Request – ${bookingRequest.package_type}</h1>
        </div>
        <div class="content">
          <h2>Booking Details</h2>
          <div class="detail-row">
            <span class="detail-label">Customer Name:</span> ${bookingRequest.first_name} ${bookingRequest.last_name}
          </div>
          <div class="detail-row">
            <span class="detail-label">Email:</span> ${bookingRequest.email}
          </div>
          <div class="detail-row">
            <span class="detail-label">Phone:</span> ${bookingRequest.phone_number}
          </div>
          <div class="detail-row">
            <span class="detail-label">Package:</span> ${bookingRequest.package_type}
          </div>
          <div class="detail-row">
            <span class="detail-label">Travel Date:</span> ${new Date(bookingRequest.travel_date).toLocaleDateString()}
          </div>
          <div class="detail-row">
            <span class="detail-label">Traveler Type:</span> ${bookingRequest.traveler_type}
          </div>
          <div class="detail-row">
            <span class="detail-label">Number of Travelers:</span> ${bookingRequest.group_size}
          </div>
          <div class="detail-row">
            <span class="detail-label">Estimated Amount:</span> ${bookingRequest.display_currency} ${bookingRequest.display_amount.toLocaleString()}
          </div>
          <div class="detail-row">
            <span class="detail-label">Guide ID:</span> ${bookingRequest.guide_id || "Not selected"}
          </div>
          <div class="detail-row">
            <span class="detail-label">Special Requests:</span> ${bookingRequest.specific_requests}
          </div>
          
          <div class="reminder">
            <strong>⚠️ Reminder:</strong> Please check availability before approving. Once approved, the system will automatically send a payment link to the customer.
          </div>
          
          <div class="action-buttons">
            <a href="${approveLink}" class="button approve-btn">Approve Booking</a>
            <a href="${rejectLink}" class="button reject-btn">Reject Booking</a>
          </div>
          
          <p style="text-align: center; color: #666; font-size: 14px;">
            Booking Request ID: ${bookingRequest.id}<br>
            Submitted: ${new Date(bookingRequest.created_at).toLocaleString()}
          </p>
        </div>
      </div>
    </body>
    </html>
  `

  try {
    await client.sendEmail({
      From: process.env.EMAIL_FROM || "bookings@experienceplateau.com",
      To: adminEmail,
      Subject: `New Booking Request – ${bookingRequest.package_type}`,
      HtmlBody: emailHTML,
      MessageStream: "outbound",
    })
    console.log("Admin notification email sent")
  } catch (error) {
    console.error(" Error sending admin notification:", error)
  }
}

async function sendCustomerConfirmationEmail(bookingRequest) {
  const emailHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #5A8E00; color: white; padding: 20px; text-align: center; }
        .content { background-color: #f9f9f9; padding: 20px; }
        .detail-row { margin: 10px 0; }
        .detail-label { font-weight: bold; color: #5A8E00; }
        .footer { text-align: center; color: #666; font-size: 14px; padding: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Booking Request Received</h1>
        </div>
        <div class="content">
          <p>Hi ${bookingRequest.first_name},</p>
          <p>Thank you for your booking request with Experience Plateau!</p>
          <p>We have received your request for the <strong>${bookingRequest.package_type}</strong> package and our team is currently reviewing availability for your requested travel date.</p>
          
          <h3>Your Booking Details:</h3>
          <div class="detail-row">
            <span class="detail-label">Package:</span> ${bookingRequest.package_type}
          </div>
          <div class="detail-row">
            <span class="detail-label">Travel Date:</span> ${new Date(bookingRequest.travel_date).toLocaleDateString()}
          </div>
          <div class="detail-row">
            <span class="detail-label">Number of Travelers:</span> ${bookingRequest.group_size}
          </div>
          <div class="detail-row">
            <span class="detail-label">Estimated Amount:</span> ${bookingRequest.display_currency} ${bookingRequest.display_amount.toLocaleString()}
          </div>
          
          <p><strong>What happens next?</strong></p>
          <ul>
            <li>Our team will review your request within 24-48 hours</li>
            <li>We'll check availability for your requested dates</li>
            <li>You'll receive an email with our decision</li>
            <li>If approved, you'll receive a secure payment link</li>
            <li>Payment is only required after approval</li>
          </ul>
          
          <p>If you have any questions in the meantime, feel free to contact us.</p>
          
          <p>Thank you for choosing Experience Plateau!</p>
        </div>
        <div class="footer">
          <p>Reference Number: ${bookingRequest.id}</p>
          <p>Experience Plateau<br>
          📧 bookings@experienceplateau.com<br>
          📞 +234-708-685-5211</p>
        </div>
      </div>
    </body>
    </html>
  `

  try {
    await client.sendEmail({
      From: process.env.EMAIL_FROM || "bookings@experienceplateau.com",
      To: bookingRequest.email,
      Subject: "Booking Request Received – Experience Plateau",
      HtmlBody: emailHTML,
      MessageStream: "outbound",
    })
    console.log(" Customer confirmation email sent")
  } catch (error) {
    console.error(" Error sending customer confirmation:", error)
  }
}

async function sendApprovalEmail(bookingRequest) {
  const paymentLink = `${process.env.FRONTEND_URL || "https://www.experienceplateau.com"}/travel-booking/payment/${bookingRequest.id}`

  const emailHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #97E12B; color: #141E03; padding: 20px; text-align: center; }
        .content { background-color: #f9f9f9; padding: 20px; }
        .detail-row { margin: 10px 0; }
        .detail-label { font-weight: bold; color: #5A8E00; }
        .payment-button { display: inline-block; background-color: #5A8E00; color: white; padding: 15px 40px; text-decoration: none; border-radius: 5px; font-weight: bold; margin: 20px 0; }
        .footer { text-align: center; color: #666; font-size: 14px; padding: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🎉 Your Booking Has Been Approved!</h1>
        </div>
        <div class="content">
          <p>Hi ${bookingRequest.first_name},</p>
          <p><strong>Good news!</strong> Your booking request for the <strong>${bookingRequest.package_type}</strong> package has been approved!</p>
          
          <h3>Booking Summary:</h3>
          <div class="detail-row">
            <span class="detail-label">Package:</span> ${bookingRequest.package_type}
          </div>
          <div class="detail-row">
            <span class="detail-label">Travel Date:</span> ${new Date(bookingRequest.travel_date).toLocaleDateString()}
          </div>
          <div class="detail-row">
            <span class="detail-label">Number of Travelers:</span> ${bookingRequest.group_size}
          </div>
          <div class="detail-row">
            <span class="detail-label">Total Amount:</span> ${bookingRequest.display_currency} ${bookingRequest.display_amount.toLocaleString()}
          </div>
          
          <h3>Next Steps:</h3>
          <p>To confirm your booking, please complete payment using the button below:</p>
          <div style="text-align: center;">
            <a href="${paymentLink}" class="payment-button">Proceed to Payment</a>
          </div>
          
          <p><strong>Payment Instructions:</strong></p>
          <ul>
            <li>Click the payment button above</li>
            <li>You'll be redirected to our secure payment page</li>
            <li>Complete payment to finalize your booking</li>
            <li>You'll receive a confirmation email after successful payment</li>
          </ul>
          
          <p><strong>What happens after payment?</strong></p>
          <ul>
            <li>You'll receive a detailed itinerary</li>
            <li>Your guide will contact you with preparation details</li>
            <li>You can check out our Virtual Tour Experience on the website</li>
          </ul>
          
          <p>Thank you for choosing Experience Plateau. We look forward to hosting you!</p>
        </div>
        <div class="footer">
          <p>Reference Number: ${bookingRequest.id}</p>
          <p>Experience Plateau<br>
          📧 support@experienceplateau.com<br>
          📞 +234-708-685-5211</p>
        </div>
      </div>
    </body>
    </html>
  `

  try {
    await client.sendEmail({
      From: process.env.EMAIL_FROM || "bookings@experienceplateau.com",
      To: bookingRequest.email,
      Subject: "Your Booking Has Been Approved – Experience Plateau",
      HtmlBody: emailHTML,
      MessageStream: "outbound",
    })
    console.log(" Approval email sent")
  } catch (error) {
    console.error(" Error sending approval email:", error)
  }
}

async function sendRejectionEmail(bookingRequest) {
  const emailHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #dc3545; color: white; padding: 20px; text-align: center; }
        .content { background-color: #f9f9f9; padding: 20px; }
        .footer { text-align: center; color: #666; font-size: 14px; padding: 20px; }
        .alternative-box { background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Booking Request Update</h1>
        </div>
        <div class="content">
          <p>Hi ${bookingRequest.first_name},</p>
          <p>Thank you for your booking request for the <strong>${bookingRequest.package_type}</strong> package on ${new Date(bookingRequest.travel_date).toLocaleDateString()}.</p>
          <p>Unfortunately, we are unable to confirm your booking at this time due to limited availability on your requested dates.</p>
          
          ${bookingRequest.rejection_reason ? `<p><strong>Reason:</strong> ${bookingRequest.rejection_reason}</p>` : ""}
          
          <div class="alternative-box">
            <h3>Would you like to explore other options?</h3>
            <p>We'd be happy to help you find an alternative:</p>
            <ul>
              <li>Check other available dates</li>
              <li>Explore similar travel packages</li>
              <li>Join our waitlist for your preferred dates</li>
            </ul>
            <p>Please reply to this email or call us at <strong>+234-XXX-XXX-XXXX</strong> to discuss alternatives.</p>
          </div>
          
          <p>While this particular booking isn't available, you can check out our <strong>Virtual Tour Experience</strong> on the website. It's a great way to explore Plateau from anywhere!</p>
          
          <p>We're sorry for any disappointment, and we hope we can host you on another trip soon.</p>
        </div>
        <div class="footer">
          <p>Reference Number: ${bookingRequest.id}</p>
          <p>Experience Plateau<br>
          📧 support@experienceplateau.com<br>
          📞 +234-708-685-5211</p>
        </div>
      </div>
    </body>
    </html>
  `

  try {
    await client.sendEmail({
      From: process.env.EMAIL_FROM || "bookings@experienceplateau.com",
      To: bookingRequest.email,
      Subject: "Booking Request Update – Experience Plateau",
      HtmlBody: emailHTML,
      MessageStream: "outbound",
    })
    console.log(" Rejection email sent")
  } catch (error) {
    console.error(" Error sending rejection email:", error)
  }
}

async function sendPaymentConfirmationEmail(bookingRequest, paymentReference) {
  const emailHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #5A8E00; color: white; padding: 20px; text-align: center; }
        .content { background-color: #f9f9f9; padding: 20px; }
        .detail-row { margin: 10px 0; }
        .detail-label { font-weight: bold; color: #5A8E00; }
        .success-badge { background-color: #97E12B; color: #141E03; padding: 10px 20px; border-radius: 5px; display: inline-block; margin: 20px 0; font-weight: bold; }
        .footer { text-align: center; color: #666; font-size: 14px; padding: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🎉 Payment Confirmed!</h1>
        </div>
        <div class="content">
          <p>Hi ${bookingRequest.first_name},</p>
          <p><strong>Your payment has been received and your booking is now confirmed!</strong></p>
          
          <div class="success-badge">✓ BOOKING CONFIRMED</div>
          
          <h3>Booking Confirmation Details:</h3>
          <div class="detail-row">
            <span class="detail-label">Booking Reference:</span> ${bookingRequest.id}
          </div>
          <div class="detail-row">
            <span class="detail-label">Payment Reference:</span> ${paymentReference}
          </div>
          <div class="detail-row">
            <span class="detail-label">Package:</span> ${bookingRequest.package_type}
          </div>
          <div class="detail-row">
            <span class="detail-label">Travel Date:</span> ${new Date(bookingRequest.travel_date).toLocaleDateString()}
          </div>
          <div class="detail-row">
            <span class="detail-label">Number of Travelers:</span> ${bookingRequest.group_size}
          </div>
          <div class="detail-row">
            <span class="detail-label">Amount Paid:</span> ${bookingRequest.display_currency} ${bookingRequest.display_amount.toLocaleString()}
          </div>
          
          <h3>What's Next?</h3>
          <ul>
            <li>Your guide will contact you within 24 hours</li>
            <li>You'll receive a detailed itinerary for your trip</li>
            <li>Check your email for pre-trip preparation instructions</li>
            <li>Explore our Virtual Tour Experience to get familiar with the locations</li>
          </ul>
          
          <h3>Important Information:</h3>
          <ul>
            <li>Please save this email for your records</li>
            <li>Bring a valid ID on the day of your tour</li>
            <li>Contact us if you need to make any changes</li>
          </ul>
          
          <p>We're excited to show you the beauty of Plateau State!</p>
          
          <p>Thank you for choosing Experience Plateau!</p>
        </div>
        <div class="footer">
          <p>Booking Reference: ${bookingRequest.id}</p>
          <p>Payment Reference: ${paymentReference}</p>
          <p>Experience Plateau<br>
          📧 bookings@experienceplateau.com<br>
          📞 +234-708-685-5211</p>
        </div>
      </div>
    </body>
    </html>
  `

  try {
    await client.sendEmail({
      From: process.env.EMAIL_FROM || "bookings@experienceplateau.com",
      To: bookingRequest.email,
      Subject: "Payment Confirmed – Your Booking is Secured!",
      HtmlBody: emailHTML,
      MessageStream: "outbound",
    })
    console.log(" Payment confirmation email sent")
  } catch (error) {
    console.error(" Error sending payment confirmation email:", error)
  }
}

async function sendAdminPaymentNotification(bookingRequest, paymentReference, paymentData) {
  const emailHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #5A8E00; color: white; padding: 20px; text-align: center; }
        .content { background-color: #f9f9f9; padding: 20px; }
        .detail-row { margin: 10px 0; padding: 10px; background: white; border-left: 3px solid #5A8E00; }
        .detail-label { font-weight: bold; color: #5A8E00; display: block; margin-bottom: 5px; }
        .detail-value { color: #333; }
        .success-badge { background-color: #97E12B; color: #141E03; padding: 10px 20px; border-radius: 5px; display: inline-block; margin: 20px 0; font-weight: bold; }
        .amount { font-size: 24px; color: #5A8E00; font-weight: bold; }
        .footer { text-align: center; color: #666; font-size: 14px; padding: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>💰 Payment Received</h1>
        </div>
        <div class="content">
          <p><strong>A booking payment has been successfully processed!</strong></p>
          
          <div class="success-badge">✓ PAYMENT CONFIRMED</div>
          
          <h3>Customer Information:</h3>
          <div class="detail-row">
            <span class="detail-label">Name:</span>
            <span class="detail-value">${bookingRequest.first_name} ${bookingRequest.last_name}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Email:</span>
            <span class="detail-value">${bookingRequest.email}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Phone:</span>
            <span class="detail-value">${bookingRequest.phone_number}</span>
          </div>
          
          <h3>Booking Details:</h3>
          <div class="detail-row">
            <span class="detail-label">Booking Reference:</span>
            <span class="detail-value">${bookingRequest.id}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Package Type:</span>
            <span class="detail-value">${bookingRequest.package_type}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Travel Date:</span>
            <span class="detail-value">${new Date(bookingRequest.travel_date).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Group Size:</span>
            <span class="detail-value">${bookingRequest.group_size} ${bookingRequest.group_size === 1 ? "person" : "people"}</span>
          </div>
          ${
            bookingRequest.special_requests
              ? `
          <div class="detail-row">
            <span class="detail-label">Special Requests:</span>
            <span class="detail-value">${bookingRequest.special_requests}</span>
          </div>
          `
              : ""
          }
          
          <h3>Payment Information:</h3>
           <div class="detail-row">
            <span class="detail-label">Amount Paid:</span>
            <span class="amount">${bookingRequest.display_currency} ${bookingRequest.display_amount.toLocaleString()}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Payment Reference:</span>
            <span class="detail-value">${paymentReference}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Payment Method:</span>
            <span class="detail-value">${paymentData.channel || "Card"}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Paid At:</span>
            <span class="detail-value">${new Date(paymentData.paid_at).toLocaleString()}</span>
          </div>
          
          <h3>Next Steps:</h3>
          <ul>
            <li>Contact the customer to confirm travel arrangements</li>
            <li>Assign and notify the tour guide</li>
            <li>Send detailed itinerary to customer</li>
            <li>Verify any special requests or requirements</li>
          </ul>
        </div>
        <div class="footer">
          <p>Experience Plateau Admin Dashboard<br>
          This is an automated notification</p>
        </div>
      </div>
    </body>
    </html>
  `

  try {
    await client.sendEmail({
      From: process.env.EMAIL_FROM || "bookings@experienceplateau.com",
      To: process.env.ADMIN_EMAIL || "bookings@experienceplateau.com",
      Subject: `💰 Payment Received - ${bookingRequest.first_name} ${bookingRequest.last_name} - ₦${bookingRequest.estimated_amount.toLocaleString()}`,
      HtmlBody: emailHTML,
      MessageStream: "outbound",
    })
    console.log("Admin payment notification sent")
  } catch (error) {
    console.error(" Error sending admin payment notification:", error)
  }
}

module.exports = router
