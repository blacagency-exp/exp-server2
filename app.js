require("dotenv").config()
const express = require("express")
const cors = require("cors")
const axios = require("axios")
const { createClient } = require("@supabase/supabase-js")
const postmark = require("postmark")
const fs = require("fs")
const path = require("path")
const https = require("https")
const http = require("http")
const app = express()
const port = process.env.PORT || 5000
const nodemailer = require("nodemailer")

const bookingRequestRoutes = require("./booking-request-routes")
const shopRequestRoutes = require("./shop-request-routes")
app.use(cors())
app.use(express.json())

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY
const PAYSTACK_BASE_URL = "https://api.paystack.co"

// Create a client instance with your server token
const client = new postmark.ServerClient(process.env.POSTMARK_SERVER_TOKEN)



// Test route
app.get("/", (req, res) => {
  res.json({ message: "Server is running!" })
})

app.use("/api", bookingRequestRoutes)
app.use("/api", shopRequestRoutes)

// Supabase setup
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_ANON_KEY
const supabase = createClient(supabaseUrl, supabaseKey)

if (!PAYSTACK_SECRET_KEY || !PAYSTACK_SECRET_KEY.startsWith("sk_")) {
  console.error("Invalid or missing PAYSTACK_SECRET_KEY. Please check your .env file.")
  process.exit(1)
}

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase credentials. Please check your .env file.")
  process.exit(1)
}

// Helper function to calculate 24-hour expiration
function get24HourExpiration() {
  const now = new Date()
  const expiration = new Date(now.getTime() + 24 * 60 * 60 * 1000) // Add 24 hours
  return expiration.toISOString()
}

// Helper function to check if access has expired
function isAccessExpired(expiresAt) {
  if (!expiresAt) return false
  const now = new Date()
  const expiration = new Date(expiresAt)
  return now > expiration
}

// Helper function to create access record with retry logic
async function createAccessRecord(email, tourId, accessCode, retries = 3) {
  const expirationTime = get24HourExpiration()

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Creating access record - Attempt ${attempt}/${retries}`)

      // First, delete any existing record for this user and tour
      await supabase.from("user_tour_access").delete().eq("email", email).eq("tour_id", tourId)

      // Then create a new access record
      const { data: accessData, error: accessError } = await supabase
        .from("user_tour_access")
        .insert({
          email: email,
          tour_id: tourId,
          access_code: accessCode,
          granted_at: new Date().toISOString(),
          expires_at: expirationTime,
        })
        .select()

      if (accessError) {
        console.error(`Access record creation failed on attempt ${attempt}:`, accessError)
        if (attempt === retries) {
          throw accessError
        }
        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
        continue
      }

      console.log("Access record created successfully:", accessData)
      return { success: true, data: accessData, expiresAt: expirationTime }
    } catch (error) {
      console.error(`Access record creation error on attempt ${attempt}:`, error)
      if (attempt === retries) {
        return { success: false, error: error.message }
      }
      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
    }
  }
}
// Generate booking reference for hotels
function generateHotelBookingReference() {
  const timestamp = Date.now().toString().slice(-6)
  const random = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0")
  return `HTL-${timestamp}${random}`
}

// ===== HOTEL BOOKING ENDPOINTS =====

// Get all hotels with room types
app.get("/api/hotels", async (req, res) => {
  try {
    const { data: hotels, error: hotelsError } = await supabase
      .from("hotels")
      .select(`
        *,
        room_types (*)
      `)
      .eq("is_active", true)

    if (hotelsError) {
      console.error("Error fetching hotels:", hotelsError)
      return res.status(500).json({ error: "Failed to fetch hotels" })
    }

    res.json(hotels || [])
  } catch (error) {
    console.error("Unexpected error fetching hotels:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Initialize hotel booking payment
app.post("/api/initialize-hotel-booking", async (req, res) => {
  try {
    const {
      guestName,
      guestEmail,
      guestPhone,
      hotelId,
      roomTypeId,
      checkInDate,
      checkOutDate,
      numberOfGuests,
      numberOfNights,
      totalAmount,
      specialRequests,
    } = req.body

    console.log("Received hotel booking initialization:", {
      guestName,
      guestEmail,
      guestPhone,
      hotelId,
      roomTypeId,
      checkInDate,
      checkOutDate,
      numberOfGuests,
      numberOfNights,
      totalAmount,
    })

    // Get hotel and room type details
    const { data: hotel, error: hotelError } = await supabase.from("hotels").select("*").eq("id", hotelId).single()

    if (hotelError || !hotel) {
      return res.status(404).json({ error: "Hotel not found" })
    }

    const { data: roomType, error: roomTypeError } = await supabase
      .from("room_types")
      .select("*")
      .eq("id", roomTypeId)
      .single()

    if (roomTypeError || !roomType) {
      return res.status(404).json({ error: "Room type not found" })
    }

    // Calculate commission (10%)
    const platformCommission = totalAmount * 0.1
    const hotelAmount = totalAmount - platformCommission

    // Generate booking reference
    const bookingReference = generateHotelBookingReference()

    // Create customer on Paystack
    try {
      const customerResponse = await axios.post(
        `${PAYSTACK_BASE_URL}/customer`,
        {
          email: guestEmail,
          first_name: guestName.split(" ")[0],
          last_name: guestName.split(" ").slice(1).join(" "),
          phone: guestPhone,
        },
        {
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            "Content-Type": "application/json",
          },
        },
      )
      console.log("Customer created/updated on Paystack:", customerResponse.data)
    } catch (customerError) {
      console.error(
        "Customer creation failed:",
        customerError.response ? customerError.response.data : customerError.message,
      )
    }

    // Initialize payment with Paystack
    const response = await axios.post(
      `${PAYSTACK_BASE_URL}/transaction/initialize`,
      {
        email: guestEmail,
        amount: Math.round(totalAmount * 100), // Convert to kobo
        metadata: {
          booking_type: "hotel_booking",
          hotel_name: hotel.name,
          room_type: roomType.name,
          check_in: checkInDate,
          check_out: checkOutDate,
          nights: numberOfNights,
          guests: numberOfGuests,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      },
    )

    console.log("Paystack API response:", response.data)

    // Save booking details to Supabase
    const bookingData = {
      booking_reference: bookingReference,
      guest_name: guestName,
      guest_email: guestEmail,
      guest_phone: guestPhone,
      hotel_id: hotelId,
      room_type_id: roomTypeId,
      check_in_date: checkInDate,
      check_out_date: checkOutDate,
      number_of_guests: numberOfGuests,
      number_of_nights: numberOfNights,
      total_amount: totalAmount,
      platform_commission: platformCommission,
      hotel_amount: hotelAmount,
      special_requests: specialRequests,
      payment_reference: response.data.data.reference,
      payment_status: "pending",
      booking_status: "pending",
    }

    console.log("Attempting to save hotel booking to Supabase:", bookingData)

    const { data, error } = await supabase.from("hotel_bookings").insert([bookingData])

    if (error) {
      console.error("Error saving hotel booking to Supabase:", error)
      throw new Error(`Failed to save booking: ${error.message}`)
    }

    console.log("Hotel booking saved successfully:", data)

    res.json(response.data)
  } catch (error) {
    console.error("Hotel booking initialization failed:", error.response ? error.response.data : error.message)
    res.status(500).json({
      error: "Failed to initialize hotel booking payment",
      details: error.message,
    })
  }
})

// Verify hotel booking payment
app.get("/api/verify-hotel-booking/:reference", async (req, res) => {
  try {
    const { reference } = req.params
    console.log("Received hotel booking payment verification for reference:", reference)

    // Verify payment with Paystack
    const response = await axios.get(`${PAYSTACK_BASE_URL}/transaction/verify/${reference}`, {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    })

    console.log("Paystack verification response:", JSON.stringify(response.data, null, 2))

    const paymentStatus = response.data.data.status
    let bookingStatus

    switch (paymentStatus) {
      case "success":
        bookingStatus = "completed"
        break
      case "failed":
        bookingStatus = "failed"
        break
      case "abandoned":
        bookingStatus = "abandoned"
        break
      default:
        bookingStatus = "pending"
    }

    // Update booking status in Supabase
    const { data: updateData, error: updateError } = await supabase
      .from("hotel_bookings")
      .update({ payment_status: bookingStatus })
      .eq("payment_reference", reference)
      .select()
      .single()

    if (updateError) {
      console.error("Error updating hotel booking payment status:", updateError)
      throw new Error(`Failed to update payment status: ${updateError.message}`)
    }

    if (paymentStatus === "success") {
      // Generate receipt number
      const receiptNumber = `HTL-RCP-${Date.now()}-${Math.floor(Math.random() * 1000)}`

      // Update with receipt number
      await supabase.from("hotel_bookings").update({ receipt_number: receiptNumber }).eq("payment_reference", reference)

      // Get hotel and room type details for email
      const { data: hotel } = await supabase.from("hotels").select("*").eq("id", updateData.hotel_id).single()

      const { data: roomType } = await supabase
        .from("room_types")
        .select("*")
        .eq("id", updateData.room_type_id)
        .single()

      // Send confirmation emails
      await sendHotelBookingEmails(updateData, hotel, roomType, receiptNumber, response.data.data)

      res.json({
        status: bookingStatus,
        message: `Payment ${bookingStatus}`,
        bookingReference: updateData.booking_reference,
        paymentDetails: response.data.data,
      })
    } else {
      res.json({
        status: bookingStatus,
        message: `Payment ${bookingStatus}`,
        paymentDetails: response.data.data,
      })
    }
  } catch (error) {
    console.error("Hotel booking payment verification failed:", error.response ? error.response.data : error.message)
    res.status(500).json({
      error: "Failed to verify hotel booking payment",
      details: error.message,
    })
  }
})

// Function to send hotel booking confirmation emails
async function sendHotelBookingEmails(booking, hotel, roomType, receiptNumber, paymentDetails) {
  const paymentDate = new Date(paymentDetails.paid_at || Date.now()).toLocaleDateString()
  const checkInDate = new Date(booking.check_in_date).toLocaleDateString()
  const checkOutDate = new Date(booking.check_out_date).toLocaleDateString()

  // Guest confirmation email HTML
  const guestHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd;">
      <div style="text-align: center; margin-bottom: 20px;">
        <h1 style="color: #5A8E00;">Hotel Booking Confirmation</h1>
        <p>Receipt #: ${receiptNumber}</p>
        <p>Booking Reference: ${booking.booking_reference}</p>
      </div>
      
      <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin-bottom: 20px; border-left: 4px solid #5A8E00;">
        <h2 style="color: #5A8E00; margin-top: 0;">What Happens Next?</h2>
        <ol style="padding-left: 20px;">
          <li style="margin-bottom: 10px;"><strong>Booking Coordination:</strong> Our team will contact ${hotel.name} within 2 hours to confirm your reservation.</li>
          <li style="margin-bottom: 10px;"><strong>Hotel Confirmation:</strong> You'll receive final confirmation with check-in details within 24 hours.</li>
          <li style="margin-bottom: 10px;"><strong>Check-in:</strong> Present this confirmation at the hotel reception on your arrival date.</li>
        </ol>
        <p><strong>Need immediate assistance?</strong> Contact our support team:</p>
        <ul style="list-style-type: none; padding-left: 0;">
          <li>📞 Phone: +234 708 685 5211</li>
          <li>✉️ Email: bookings@experienceplateau.com</li>
          <li>⏰ Support Hours: Monday-Friday, 9am-5pm</li>
        </ul>
      </div>

      <div style="margin-bottom: 20px;">
        <h2>Booking Details</h2>
        <p><strong>Guest Name:</strong> ${booking.guest_name}</p>
        <p><strong>Email:</strong> ${booking.guest_email}</p>
        <p><strong>Phone:</strong> ${booking.guest_phone}</p>
        <p><strong>Payment Date:</strong> ${paymentDate}</p>
      </div>

      <div style="margin-bottom: 20px;">
        <h2>Hotel Information</h2>
        <p><strong>Hotel:</strong> ${hotel.name}</p>
        <p><strong>Location:</strong> ${hotel.location}</p>
        <p><strong>Address:</strong> ${hotel.address}</p>
        <p><strong>Contact:</strong> ${hotel.contact_phone}</p>
        <p><strong>Email:</strong> ${hotel.contact_email}</p>
      </div>

      <div style="margin-bottom: 20px;">
        <h2>Reservation Details</h2>
        <p><strong>Room Type:</strong> ${roomType.name}</p>
        <p><strong>Check-in Date:</strong> ${checkInDate}</p>
        <p><strong>Check-out Date:</strong> ${checkOutDate}</p>
        <p><strong>Number of Nights:</strong> ${booking.number_of_nights}</p>
        <p><strong>Number of Guests:</strong> ${booking.number_of_guests}</p>
        ${booking.special_requests ? `<p><strong>Special Requests:</strong> ${booking.special_requests}</p>` : ""}
      </div>

      <div style="margin-bottom: 20px;">
        <h2>Payment Information</h2>
        <p><strong>Total Amount:</strong> ₦${booking.total_amount.toLocaleString()}</p>
        <p><strong>Payment Reference:</strong> ${booking.payment_reference}</p>
        <p><strong>Payment Status:</strong> Completed</p>
      </div>

      <div style="margin-top: 30px; border-top: 1px solid #ddd; padding-top: 20px; text-align: center;">
        <p>Thank you for booking with Experience Plateau! We're excited to help you enjoy your stay in Plateau State.</p>
        <p>If you have any questions, please contact us at bookings@experienceplateau.com</p>
      </div>
    </div>
  `

  // Admin notification email HTML
  const adminHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd;">
      <h1 style="color: #5A8E00;">New Hotel Booking</h1>
      <p>Receipt #: ${receiptNumber}</p>
      <p>Booking Reference: ${booking.booking_reference}</p>
      
      <h2>Guest Information</h2>
      <p><strong>Name:</strong> ${booking.guest_name}</p>
      <p><strong>Email:</strong> ${booking.guest_email}</p>
      <p><strong>Phone:</strong> ${booking.guest_phone}</p>
      
      <h2>Hotel Details</h2>
      <p><strong>Hotel:</strong> ${hotel.name}</p>
      <p><strong>Location:</strong> ${hotel.location}</p>
      <p><strong>Hotel Contact:</strong> ${hotel.contact_phone}</p>
      <p><strong>Hotel Email:</strong> ${hotel.contact_email}</p>
      
      <h2>Booking Details</h2>
      <p><strong>Room Type:</strong> ${roomType.name}</p>
      <p><strong>Check-in:</strong> ${checkInDate}</p>
      <p><strong>Check-out:</strong> ${checkOutDate}</p>
      <p><strong>Nights:</strong> ${booking.number_of_nights}</p>
      <p><strong>Guests:</strong> ${booking.number_of_guests}</p>
      <p><strong>Special Requests:</strong> ${booking.special_requests || "None"}</p>
      
      <h2>Payment Information</h2>
      <p><strong>Total Amount:</strong> ₦${booking.total_amount.toLocaleString()}</p>
      <p><strong>Platform Commission (10%):</strong> ₦${booking.platform_commission.toLocaleString()}</p>
      <p><strong>Hotel Amount:</strong> ₦${booking.hotel_amount.toLocaleString()}</p>
      <p><strong>Payment Date:</strong> ${paymentDate}</p>
      <p><strong>Payment Reference:</strong> ${booking.payment_reference}</p>
      <p><strong>Payment Channel:</strong> ${paymentDetails.channel || "N/A"}</p>
      
      <div style="background-color: #fff3cd; padding: 15px; border-radius: 5px; margin-top: 20px;">
        <h3 style="color: #856404; margin-top: 0;">Action Required</h3>
        <p style="color: #856404; margin: 0;">Please contact ${hotel.name} immediately to confirm this reservation and coordinate room availability.</p>
      </div>
    </div>
  `

  // Hotel notification email HTML
  const hotelHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd;">
      <h1 style="color: #5A8E00;">New Booking Notification</h1>
      <p>Dear ${hotel.name} Team,</p>
      <p>You have received a new booking through Experience Plateau. Please find the details below:</p>
      
      <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
        <h2>Booking Reference: ${booking.booking_reference}</h2>
        <p><strong>Receipt #:</strong> ${receiptNumber}</p>
      </div>
      
      <h2>Guest Information</h2>
      <p><strong>Name:</strong> ${booking.guest_name}</p>
      <p><strong>Email:</strong> ${booking.guest_email}</p>
      <p><strong>Phone:</strong> ${booking.guest_phone}</p>
      
      <h2>Reservation Details</h2>
      <p><strong>Room Type:</strong> ${roomType.name}</p>
      <p><strong>Check-in Date:</strong> ${checkInDate}</p>
      <p><strong>Check-out Date:</strong> ${checkOutDate}</p>
      <p><strong>Number of Nights:</strong> ${booking.number_of_nights}</p>
      <p><strong>Number of Guests:</strong> ${booking.number_of_guests}</p>
      ${booking.special_requests ? `<p><strong>Special Requests:</strong> ${booking.special_requests}</p>` : ""}
      
      <h2>Payment Information</h2>
      <p><strong>Total Booking Value:</strong> ₦${booking.total_amount.toLocaleString()}</p>
      <p><strong>Your Amount (90%):</strong> ₦${booking.hotel_amount.toLocaleString()}</p>
      <p><strong>Platform Fee (10%):</strong> ₦${booking.platform_commission.toLocaleString()}</p>
      <p><strong>Payment Status:</strong> Completed</p>
      
      <div style="background-color: #d4edda; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #28a745;">
        <h3 style="color: #155724; margin-top: 0;">Next Steps</h3>
        <ol style="color: #155724; padding-left: 20px;">
          <li>Please confirm room availability for the specified dates</li>
          <li>Contact the guest directly to confirm check-in details</li>
          <li>Prepare the ${roomType.name} for the guest's arrival</li>
          <li>Payment will be processed to your account within 3-5 business days</li>
        </ol>
      </div>
      
      <p>If you have any questions about this booking, please contact Experience Plateau at bookings@experienceplateau.com</p>
      
      <p>Thank you for partnering with Experience Plateau!</p>
    </div>
  `

  try {
    // Send guest confirmation email
    await client.sendEmail({
      From: process.env.EMAIL_FROM || "bookings@experienceplateau.com",
      To: booking.guest_email,
      Subject: `Hotel Booking Confirmation - ${hotel.name}`,
      HtmlBody: guestHtml,
      MessageStream: "outbound",
    })

    // Send admin notification
    await client.sendEmail({
      From: process.env.EMAIL_FROM || "bookings@experienceplateau.com",
      To: process.env.ADMIN_EMAIL || "bookings@experienceplateau.com",
      Subject: `New Hotel Booking: ${hotel.name} - ${booking.guest_name}`,
      HtmlBody: adminHtml,
      MessageStream: "outbound",
    })

    // Send hotel notification
    await client.sendEmail({
      From: process.env.EMAIL_FROM || "bookings@experienceplateau.com",
      To: hotel.contact_email || "bookings@experienceplateau.com",
      Subject: `New Booking Notification - ${booking.booking_reference}`,
      HtmlBody: hotelHtml,
      MessageStream: "outbound",
    })

    console.log("Hotel booking confirmation emails sent successfully")
  } catch (error) {
    console.error("Error sending hotel booking emails:", error)
  }
}

// ===== END HOTEL BOOKING ENDPOINTS =====

// ADD DEBUG ENDPOINT TO CHECK DATABASE ENTRIES
app.get("/api/debug-user-access/:email", async (req, res) => {
  try {
    const { email } = req.params

    console.log("=== DEBUG USER ACCESS ===")
    console.log("Email:", email)

    // Check virtual_tour_payments table
    const { data: payments, error: paymentsError } = await supabase
      .from("virtual_tour_payments")
      .select("*")
      .eq("email", email)
      .eq("payment_status", "completed")

    console.log("Virtual tour payments:", payments)
    console.log("Payments error:", paymentsError)

    // Check user_tour_access table
    const { data: access, error: accessError } = await supabase.from("user_tour_access").select("*").eq("email", email)

    console.log("User tour access:", access)
    console.log("Access error:", accessError)

    res.json({
      email,
      payments: payments || [],
      access: access || [],
      paymentsError,
      accessError,
    })
  } catch (error) {
    console.error("Debug endpoint error:", error)
    res.status(500).json({ error: error.message })
  }
})

// FIXED ENDPOINT TO MANUALLY FIX ACCESS
app.post("/api/fix-user-access", async (req, res) => {
  try {
    const { email, accessCode } = req.body

    console.log("=== FIXING USER ACCESS ===")
    console.log("Email:", email)
    console.log("Access Code:", accessCode)

    // Find the payment record
    const { data: payment, error: paymentError } = await supabase
      .from("virtual_tour_payments")
      .select("*")
      .eq("access_code", accessCode)
      .eq("payment_status", "completed")
      .single()

    if (paymentError || !payment) {
      console.error("Payment not found:", paymentError)
      return res.status(404).json({
        success: false,
        message: "Payment not found",
        error: paymentError,
      })
    }

    console.log("Found payment:", payment)

    // Create or update user_tour_access entry
    const expirationTime = get24HourExpiration()

    // First, try to delete any existing record for this user and tour
    const { error: deleteError } = await supabase
      .from("user_tour_access")
      .delete()
      .eq("email", payment.email)
      .eq("tour_id", payment.tour_id)

    console.log("Delete existing access record result:", deleteError)

    // Now insert the new record
    const { data: accessData, error: accessError } = await supabase
      .from("user_tour_access")
      .insert({
        email: payment.email,
        tour_id: payment.tour_id,
        access_code: payment.access_code,
        granted_at: new Date().toISOString(),
        expires_at: expirationTime,
      })
      .select()

    if (accessError) {
      console.error("Failed to create access record:", accessError)
      return res.status(500).json({
        success: false,
        message: "Failed to create access record",
        error: accessError,
        details: accessError.message,
      })
    }

    console.log("Access record created successfully:", accessData)

    res.json({
      success: true,
      message: "Access fixed successfully",
      payment,
      accessData,
      expiresAt: expirationTime,
    })
  } catch (error) {
    console.error("Fix access error:", error)
    res.status(500).json({
      success: false,
      message: "Failed to fix access",
      error: error.message,
    })
  }
})

app.post("/api/subscribe", async (req, res) => {
  const { email } = req.body
  console.log("Received subscription request for email:", email)

  if (!email || !/\S+@\S+\.\S+/.test(email)) {
    console.log("Invalid email address:", email)
    return res.status(400).json({ message: "Invalid email address" })
  }

  try {
    // Check if the email already exists in the subscribers table
    const { data: existingSubscribers, error: checkError } = await supabase
      .from("subscribers")
      .select("email")
      .eq("email", email)

    if (checkError) {
      console.error("Error checking existing subscriber:", checkError)
      return res.status(500).json({ message: "Failed to check existing subscriber", error: checkError })
    }

    if (existingSubscribers && existingSubscribers.length > 0) {
      console.log("Email already subscribed:", email)
      return res.status(409).json({ message: "Email already subscribed" })
    }

    // Insert new subscriber
    const { data, error } = await supabase.from("subscribers").insert([{ email }])

    if (error) {
      console.error("Error saving subscriber to Supabase:", error)
      return res.status(500).json({ message: "Failed to save subscriber", error: error })
    }

    console.log("Subscriber saved successfully:", data)
    res.status(200).json({ message: "Subscription successful" })
  } catch (error) {
    console.error("Unexpected error during subscription:", error)
    res.status(500).json({ message: "Internal server error", error: error.message })
  }
})

app.get("/api/subscribers", async (req, res) => {
  try {
    const { data, error } = await supabase.from("subscribers").select("*").order("created_at", { ascending: false })

    if (error) {
      console.error("Error fetching subscribers:", error)
      throw new Error("Failed to fetch subscribers")
    }

    console.log("Fetched subscribers:", data)
    res.status(200).json(data)
  } catch (error) {
    console.error("Error retrieving subscribers:", error)
    res.status(500).json({ message: "Internal server error", error: error.message })
  }
})

// Add this new endpoint to create a customer on Paystack
app.post("/api/create-customer", async (req, res) => {
  try {
    const { email, first_name, last_name, phone } = req.body
    const response = await axios.post(
      `${PAYSTACK_BASE_URL}/customer`,
      {
        email,
        first_name,
        last_name,
        phone,
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      },
    )

    console.log("Customer created on Paystack:", response.data)
    res.json(response.data)
  } catch (error) {
    console.error("Customer creation failed:", error.response ? error.response.data : error.message)
    res.status(500).json({ error: "Failed to create customer", details: error.message })
  }
})

app.post("/api/initialize-payment", async (req, res) => {
  try {
    const { email, amount, metadata, name, phone } = req.body
    console.log("Received payment initialization request:", { email, amount, metadata, name, phone })

    try {
      const customerResponse = await axios.post(
        `${PAYSTACK_BASE_URL}/customer`,
        {
          email,
          first_name: metadata.full_name.split(" ")[0],
          last_name: metadata.full_name.split(" ")[1],
          phone: metadata.phone_number,
        },
        {
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            "Content-Type": "application/json",
          },
        },
      )
      console.log("Customer created/updated on Paystack:", customerResponse.data)
    } catch (customerError) {
      // Log the error but continue with payment initialization
      console.error(
        "Customer creation failed:",
        customerError.response ? customerError.response.data : customerError.message,
      )
    }

    const response = await axios.post(
      `${PAYSTACK_BASE_URL}/transaction/initialize`,
      {
        email,
        amount: Math.round(amount * 100), // Convert to kobo and ensure it's an integer
        name, // Send to Paystack's name parameter
        phone,
        metadata: {
          ...metadata,
          internal_id: "YOUR_INTERNAL_ID", // Add any additional metadata
        },
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      },
    )

    console.log("Paystack API response:", response.data)

    // Save initial booking details to Supabase
    const bookingData = {
      email,
      amount,
      payment_reference: response.data.data.reference,
      payment_status: "pending",
      first_name: metadata.full_name.split(" ")[0],
      last_name: metadata.full_name.split(" ")[1],
      phone_number: metadata.phone_number,
      package_type: metadata.package_type,
      traveler_type: metadata.traveler_type,
      group_size: metadata.group_size,
      specific_requests: metadata.specific_requests,
      guide_id: metadata.guide_id,
    }

    console.log("Attempting to save booking data to Supabase:", bookingData)

    const { data, error } = await supabase.from("bookings").insert([bookingData])

    if (error) {
      console.error("Error saving booking to Supabase:", error)
      throw new Error(`Failed to save booking: ${error.message}`)
    } else {
      console.log("Booking saved successfully:", data)
    }

    res.json(response.data)
  } catch (error) {
    console.error("Payment initialization failed:", error.response ? error.response.data : error.message)
    res.status(500).json({ error: "Failed to initialize payment", details: error.message })
  }
})

app.get("/test-email-postmark", async (req, res) => {
  try {
    const testBooking = {
      first_name: "Test",
      last_name: "User",
      email: "bookings@experienceplateau.com", // Use your email for testing
      phone_number: "1234567890",
      package_type: "Premium Tour",
      traveler_type: "Individual",
      amount: 25000,
      payment_reference: "TEST-REF-123",
      payment_status: "completed",
      specific_requests: "None",
    }

    await sendReceiptEmails(testBooking, "TEST-RCP-123", { paid_at: new Date(), channel: "card" })

    res.send("Test email sent successfully via Postmark")
  } catch (error) {
    console.error("Email test failed:", error)
    res.status(500).send(`Error: ${error.message}`)
  }
})

app.get("/api/verify-payment/:reference", async (req, res) => {
  try {
    const { reference } = req.params
    console.log("Received payment verification request for reference:", reference)

    const response = await axios.get(`${PAYSTACK_BASE_URL}/transaction/verify/${reference}`, {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    })

    console.log("Paystack API verification response:", JSON.stringify(response.data, null, 2))

    const paymentStatus = response.data.data.status
    let bookingStatus

    switch (paymentStatus) {
      case "success":
        bookingStatus = "completed"
        break
      case "failed":
        bookingStatus = "failed"
        break
      case "abandoned":
        bookingStatus = "abandoned"
        break
      default:
        bookingStatus = "pending"
    }

    // Update booking status in Supabase
    const { data, error } = await supabase
      .from("bookings")
      .update({ payment_status: bookingStatus })
      .eq("payment_reference", reference)

    if (paymentStatus === "success") {
      // Get full booking details from database
      const { data: bookingData, error: bookingError } = await supabase
        .from("bookings")
        .select("*")
        .eq("payment_reference", reference)
        .single()

      if (bookingError) throw bookingError

      // Generate receipt number
      const receiptNumber = `RCP-${Date.now()}-${Math.floor(Math.random() * 1000)}`

      // Update booking with receipt number
      await supabase.from("bookings").update({ receipt_number: receiptNumber }).eq("payment_reference", reference)

      // Send receipt emails
      await sendReceiptEmails(bookingData, receiptNumber, response.data.data)

      // If a guide was selected, send notification to the guide
      if (bookingData.guide_id) {
        await sendGuideNotification(bookingData, receiptNumber)
      }
    }

    if (error) {
      console.error("Error updating booking status in Supabase:", error)
      throw new Error(`Failed to update booking status: ${error.message}`)
    } else {
      console.log("Booking status updated successfully:", data)
    }

    res.json({
      status: bookingStatus,
      message: `Payment ${bookingStatus}`,
      paymentDetails: response.data.data,
    })
  } catch (error) {
    console.error("Payment verification failed:", error.response ? error.response.data : error.message)
    res.status(500).json({ error: "Failed to verify payment", details: error.message })
  }
})

// Define a GET endpoint to retrieve guides
app.get("/api/guides", async (req, res) => {
  try {
    const { data, error } = await supabase.from("guides").select("*")

    if (error) {
      console.error("Error fetching guides:", error)
      return res.status(500).json({ error: "Failed to fetch guides" })
    }

    res.json(data)
  } catch (error) {
    console.error("Unexpected error:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Test Supabase connection
app.get("/api/test-supabase", async (req, res) => {
  try {
    const { data, error } = await supabase.from("bookings").select("*").limit(1)

    if (error) {
      throw error
    }

    res.json({ message: "Supabase connection successful", data })
  } catch (error) {
    console.error("Supabase connection test failed:", error)
    res.status(500).json({ error: "Failed to connect to Supabase", details: error.message })
  }
})

// Add a function to send guide notification emails
async function sendGuideNotification(booking, receiptNumber) {
  try {
    // Get guide information from your database
    const { data: guideData, error: guideError } = await supabase
      .from("guides")
      .select("*")
      .eq("id", booking.guide_id)
      .single()

    if (guideError) {
      console.error("Error fetching guide data:", guideError)
      return
    }

    // Format date
    const bookingDate = new Date().toLocaleDateString()

    // Guide notification HTML template
    const guideHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd;">
        <div style="text-align: center; margin-bottom: 20px;">
          <h1 style="color: #5A8E00;">New Tour Assignment</h1>
        </div>
        
        <p>Hello ${guideData.name},</p>
        
        <p>You have been selected as a guide for an upcoming tour. Here are the details:</p>
        
        <div style="margin-bottom: 20px;">
          <h2>Customer Information</h2>
          <p><strong>Name:</strong> ${booking.first_name} ${booking.last_name}</p>
          <p><strong>Email:</strong> ${booking.email}</p>
          <p><strong>Phone:</strong> ${booking.phone_number}</p>
          
          <h2>Booking Details</h2>
          <p><strong>Package:</strong> ${booking.package_type}</p>
          <p><strong>Traveler Type:</strong> ${booking.traveler_type}</p>
          ${booking.group_size ? `<p><strong>Group Size:</strong> ${booking.group_size}</p>` : ""}
          <p><strong>Receipt Number:</strong> ${receiptNumber}</p>
          <p><strong>Booking Date:</strong> ${bookingDate}</p>
          <p><strong>Specific Requests:</strong> ${booking.specific_requests || "None"}</p>
        </div>
        
        <div style="margin-top: 30px; border-top: 1px solid #ddd; padding-top: 20px;">
          <p>Please contact the customer within 24 hours to discuss the details of their tour.</p>
          <p>If you have any questions, please contact our booking team at bookings@experienceplateau.com</p>
        </div>
      </div>
    `

    // Send email to guide
    await client.sendEmail({
      From: process.env.EMAIL_FROM || "bookings@experienceplateau.com",
      To: guideData.email || "bookings@experienceplateau.com", // In production, use the actual guide email
      Subject: `New Tour Assignment: ${booking.first_name} ${booking.last_name}`,
      HtmlBody: guideHtml,
      MessageStream: "outbound",
    })

    console.log(`Guide notification email sent to ${guideData.name} (${guideData.email})`)
  } catch (error) {
    console.error("Error sending guide notification email:", error)
    // Continue execution even if email fails
  }
}

// Function to send receipt emails
// Replace your existing sendReceiptEmails function with this:
async function sendReceiptEmails(booking, receiptNumber, paymentDetails) {
  // Format date
  const paymentDate = new Date(paymentDetails.paid_at || Date.now()).toLocaleDateString()
  const testRecipient = booking.email

  // Customer receipt HTML (your existing template)
  const customerHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd;">
      <div style="text-align: center; margin-bottom: 20px;">
        <h1 style="color: #5A8E00;">Payment Receipt</h1>
        <p>Receipt #: ${receiptNumber}</p>
      </div>
      
      <div style="margin-bottom: 20px;">
        <h2>Booking Details</h2>
        <p><strong>Name:</strong> ${booking.first_name} ${booking.last_name}</p>
        <p><strong>Email:</strong> ${booking.email}</p>
        <p><strong>Phone:</strong> ${booking.phone_number}</p>
        <p><strong>Date:</strong> ${paymentDate}</p>
        <p><strong>Package:</strong> ${booking.package_type}</p>
        <p><strong>Traveler Type:</strong> ${booking.traveler_type}</p>
        ${booking.group_size ? `<p><strong>Group Size:</strong> ${booking.group_size}</p>` : ""}
        <p><strong>Amount Paid:</strong> ₦${(booking.amount).toLocaleString()}</p>
        <p><strong>Payment Reference:</strong> ${booking.payment_reference}</p>
      </div>
      
      <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin-top: 20px; border-left: 4px solid #5A8E00;">
        <h2 style="color: #5A8E00; margin-top: 0;">What Happens Next?</h2>
        <ol style="padding-left: 20px;">
          <li style="margin-bottom: 10px;"><strong>Tour Guide Contact:</strong> A tour guide will contact you within 24 hours to discuss your tour details and answer any questions.</li>
          <li style="margin-bottom: 10px;"><strong>Tour Confirmation:</strong> Your guide will confirm the date, time, and meeting location for your tour.</li>
          <li style="margin-bottom: 10px;"><strong>Preparation:</strong> Your guide will provide information about what to bring and how to prepare for your tour experience.</li>
        </ol>
        <p><strong>Need immediate assistance?</strong> Contact our support team:</p>
        <ul style="list-style-type: none; padding-left: 0;">
         <li>📞 Phone: +234 708 685 5211</li>
          <li>✉️ Email: support@experienceplateau.com</li>
          <li>⏰ Support Hours: Monday-Friday, 9am-5pm</li>
        </ul>
      </div>
      
      <div style="margin-top: 30px; border-top: 1px solid #ddd; padding-top: 20px; text-align: center;">
        <p>Thank you for booking with us! We're excited to help you explore Plateau State.</p>
        <p>If you have any questions, please contact us at support@experienceplateau.com</p>
      </div>
    </div>
  `

  // Admin receipt HTML (your existing template)
  const adminHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd;">
      <h1 style="color: #5A8E00;">New Booking Notification</h1>
      <p>Receipt #: ${receiptNumber}</p>
      <p>A new booking has been completed with the following details:</p>
      
      <h2>Customer Information</h2>
      <p><strong>Name:</strong> ${booking.first_name} ${booking.last_name}</p>
      <p><strong>Email:</strong> ${booking.email}</p>
      <p><strong>Phone:</strong> ${booking.phone_number}</p>
      
      <h2>Booking Details</h2>
      <p><strong>Package:</strong> ${booking.package_type}</p>
      <p><strong>Traveler Type:</strong> ${booking.traveler_type}</p>
      ${booking.group_size ? `<p><strong>Group Size:</strong> ${booking.group_size}</p>` : ""}
      <p><strong>Specific Requests:</strong> ${booking.specific_requests}</p>
      
      <h2>Payment Information</h2>
      <p><strong>Amount:</strong> ₦${(booking.amount).toLocaleString()}</p>
      <p><strong>Payment Date:</strong> ${paymentDate}</p>
      <p><strong>Payment Reference:</strong> ${booking.payment_reference}</p>
      <p><strong>Payment Status:</strong> ${booking.payment_status}</p>
      <p><strong>Payment Channel:</strong> ${paymentDetails.channel || "N/A"}</p>
      <p><strong>Payment Method:</strong> ${paymentDetails.authorization?.card_type || "N/A"}</p>
    </div>
  `

  try {
    // Send customer receipt
    await client.sendEmail({
      From: process.env.EMAIL_FROM || "bookings@experienceplateau.com",
      To: testRecipient,
      Subject: "Your Booking Receipt",
      HtmlBody: customerHtml,
      MessageStream: "outbound",
    })

    // Send admin notification
    await client.sendEmail({
      From: process.env.EMAIL_FROM || "bookings@experienceplateau.com",
      To: process.env.ADMIN_EMAIL || "bookings@experienceplateau.com",
      Subject: `New Booking: ${booking.first_name} ${booking.last_name}`,
      HtmlBody: adminHtml,
      MessageStream: "outbound",
    })

    console.log("Receipt emails sent successfully via Postmark")
  } catch (error) {
    console.error("Error sending receipt emails:", error)
    // Continue execution even if email fails
  }
}

// Add this new endpoint to handle contact form submissions
app.post("/api/contact", async (req, res) => {
  try {
    const { firstName, lastName, email, comment } = req.body
    console.log("Received contact form submission:", { firstName, lastName, email, comment })

    // Insert contact form data into Supabase
    const { data, error } = await supabase.from("contact_submissions").insert([
      {
        first_name: firstName,
        last_name: lastName,
        email,
        comment,
      },
    ])

    if (error) {
      console.error("Error saving contact form submission to Supabase:", error)
      return res.status(500).json({ message: "Failed to save contact form submission", error: error })
    }

    console.log("Contact form submission saved successfully:", data)
    res.status(200).json({ message: "Contact form submission successful" })
  } catch (error) {
    console.error("Unexpected error during contact form submission:", error)
    res.status(500).json({ message: "Internal server error", error: error.message })
  }
})

// Get all tours
app.get("/api/tours", async (req, res) => {
  try {
    const { data, error } = await supabase.from("tours").select("*")

    if (error) throw error

    res.json(data)
  } catch (error) {
    console.error("Error fetching tours:", error)
    res.status(500).json({ error: "Failed to fetch tours" })
  }
})

// Get specific tour data
app.get("/api/tours/:id", async (req, res) => {
  try {
    const { id } = req.params
    const { data, error } = await supabase.from("tours").select("*, virtual_tours(*)").eq("id", id).single()

    if (error) throw error

    res.json(data)
  } catch (error) {
    console.error("Error fetching tour:", error)
    res.status(500).json({ error: "Failed to fetch tour" })
  }
})

app.get("/video", async (req, res) => {
  const videoUrl = "https://drive.google.com/uc?export=download&id=1tVPjXiNy0NgPvIcpXt_tg_OpDK7yhxm4"
  try {
    const response = await axios.get(videoUrl, { responseType: "stream" })
    res.setHeader("Content-Type", "video/mp4") // Set the correct MIME type
    response.data.pipe(res)
  } catch (error) {
    console.error("Error fetching video:", error)
    res.status(500).send("Failed to fetch video")
  }
})

// Generate access code
function generateAccessCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  let result = ""
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) result += "-"
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

// Initialize virtual tour payment
app.post("/api/initialize-virtual-tour-payment", async (req, res) => {
  try {
    const { email, amount, tourId, tourName, firstName, lastName, phoneNumber, metadata } = req.body

    console.log("Received virtual tour payment initialization:", {
      email,
      amount,
      tourId,
      tourName,
      firstName,
      lastName,
      phoneNumber,
    })

    // Create customer on Paystack
    try {
      const customerResponse = await axios.post(
        `${PAYSTACK_BASE_URL}/customer`,
        {
          email,
          first_name: firstName,
          last_name: lastName,
          phone: phoneNumber,
        },
        {
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            "Content-Type": "application/json",
          },
        },
      )
      console.log("Customer created/updated on Paystack:", customerResponse.data)
    } catch (customerError) {
      console.error(
        "Customer creation failed:",
        customerError.response ? customerError.response.data : customerError.message,
      )
    }

    // Initialize payment with Paystack
    const response = await axios.post(
      `${PAYSTACK_BASE_URL}/transaction/initialize`,
      {
        email,
        amount: Math.round(amount * 100), // Convert to kobo
        metadata: {
          ...metadata,
          payment_type: "virtual_tour",
        },
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      },
    )

    console.log("Paystack API response:", response.data)

    // Generate access code
    const accessCode = generateAccessCode()

    // Save payment details to Supabase
    const paymentData = {
      email,
      first_name: firstName,
      last_name: lastName,
      phone_number: phoneNumber,
      tour_id: tourId,
      tour_name: tourName,
      amount,
      payment_reference: response.data.data.reference,
      payment_status: "pending",
      access_code: accessCode,
      access_code_used: false,
    }

    console.log("Attempting to save virtual tour payment to Supabase:", paymentData)

    const { data, error } = await supabase.from("virtual_tour_payments").insert([paymentData])

    if (error) {
      console.error("Error saving virtual tour payment to Supabase:", error)
      throw new Error(`Failed to save payment: ${error.message}`)
    }

    console.log("Virtual tour payment saved successfully:", data)
    res.json(response.data)
  } catch (error) {
    console.error("Virtual tour payment initialization failed:", error.response ? error.response.data : error.message)
    res.status(500).json({
      error: "Failed to initialize virtual tour payment",
      details: error.message,
    })
  }
})

// Verify virtual tour payment - IMPROVED WITH AUTOMATIC ACCESS CREATION
app.get("/api/verify-virtual-tour-payment/:reference", async (req, res) => {
  try {
    const { reference } = req.params
    console.log("Received virtual tour payment verification for reference:", reference)

    // Verify payment with Paystack
    const response = await axios.get(`${PAYSTACK_BASE_URL}/transaction/verify/${reference}`, {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    })

    console.log("Paystack verification response:", JSON.stringify(response.data, null, 2))

    const paymentStatus = response.data.data.status
    let bookingStatus

    switch (paymentStatus) {
      case "success":
        bookingStatus = "completed"
        break
      case "failed":
        bookingStatus = "failed"
        break
      case "abandoned":
        bookingStatus = "abandoned"
        break
      default:
        bookingStatus = "pending"
    }

    // Update payment status in Supabase
    const { data: updateData, error: updateError } = await supabase
      .from("virtual_tour_payments")
      .update({ payment_status: bookingStatus })
      .eq("payment_reference", reference)
      .select()
      .single()

    if (updateError) {
      console.error("Error updating virtual tour payment status:", updateError)
      throw new Error(`Failed to update payment status: ${updateError.message}`)
    }

    if (paymentStatus === "success") {
      // Generate receipt number
      const receiptNumber = `VT-RCP-${Date.now()}-${Math.floor(Math.random() * 1000)}`

      // Update with receipt number
      await supabase
        .from("virtual_tour_payments")
        .update({ receipt_number: receiptNumber })
        .eq("payment_reference", reference)

      // AUTOMATICALLY CREATE ACCESS RECORD WITH RETRY LOGIC
      console.log("=== CREATING ACCESS RECORD AUTOMATICALLY ===")
      const accessResult = await createAccessRecord(updateData.email, updateData.tour_id, updateData.access_code)

      if (accessResult.success) {
        console.log("✅ Access record created successfully automatically")
      } else {
        console.error("❌ Failed to create access record automatically:", accessResult.error)
        // Don't fail the payment - user can still use access code manually
      }

      // Send access code email with expiration info
      await sendVirtualTourAccessEmail(
        updateData,
        receiptNumber,
        response.data.data,
        accessResult.expiresAt || get24HourExpiration(),
      )

      res.json({
        status: bookingStatus,
        message: `Payment ${bookingStatus}`,
        accessCode: updateData.access_code,
        expiresAt: accessResult.expiresAt || get24HourExpiration(),
        paymentDetails: response.data.data,
        accessCreated: accessResult.success,
      })
    } else {
      res.json({
        status: bookingStatus,
        message: `Payment ${bookingStatus}`,
        paymentDetails: response.data.data,
      })
    }
  } catch (error) {
    console.error("Virtual tour payment verification failed:", error.response ? error.response.data : error.message)
    res.status(500).json({
      error: "Failed to verify virtual tour payment",
      details: error.message,
    })
  }
})

// Verify access code - UPDATED WITH AUTOMATIC ACCESS CREATION
app.post("/api/verify-access-code", async (req, res) => {
  try {
    const { accessCode, tourId } = req.body

    console.log("Verifying access code:", { accessCode, tourId })

    // Check if access code exists and is valid
    const { data, error } = await supabase
      .from("virtual_tour_payments")
      .select("*")
      .eq("access_code", accessCode)
      .eq("tour_id", tourId)
      .eq("payment_status", "completed")
      .single()

    if (error || !data) {
      console.log("Invalid access code:", error)
      return res.json({
        success: false,
        message: "Invalid access code or tour not found",
      })
    }

    // Check if access has expired by looking at user_tour_access table
    const { data: accessData, error: accessError } = await supabase
      .from("user_tour_access")
      .select("expires_at")
      .eq("access_code", accessCode)
      .eq("tour_id", tourId)
      .single()

    if (accessError || !accessData) {
      console.log("Access record not found, creating new one automatically:", accessError)

      // AUTOMATICALLY CREATE ACCESS RECORD
      const accessResult = await createAccessRecord(data.email, tourId, accessCode)

      if (!accessResult.success) {
        console.error("Failed to create access record:", accessResult.error)
        return res.json({
          success: false,
          message: "Failed to create access record",
        })
      }

      console.log("✅ New access record created automatically")

      // Mark access code as used (optional)
      await supabase.from("virtual_tour_payments").update({ access_code_used: true }).eq("access_code", accessCode)

      return res.json({
        success: true,
        message: "Access granted successfully",
        expiresAt: accessResult.expiresAt,
      })
    }

    // Check if access has expired
    if (isAccessExpired(accessData.expires_at)) {
      console.log("Access code has expired:", accessData.expires_at)
      return res.json({
        success: false,
        expired: true,
        message: "Access code has expired. Please purchase new access.",
        expiresAt: accessData.expires_at,
      })
    }

    // Mark access code as used (optional)
    await supabase.from("virtual_tour_payments").update({ access_code_used: true }).eq("access_code", accessCode)

    res.json({
      success: true,
      message: "Access granted successfully",
      expiresAt: accessData.expires_at,
    })
  } catch (error) {
    console.error("Access code verification failed:", error)
    res.status(500).json({
      success: false,
      message: "Failed to verify access code",
    })
  }
})

// Check user access - UPDATED WITH EXPIRATION FILTERING
app.post("/api/check-user-access", async (req, res) => {
  try {
    const { email, tourIds } = req.body

    if (!email || !tourIds || !Array.isArray(tourIds)) {
      return res.status(400).json({
        success: false,
        message: "Email and tourIds array are required",
      })
    }

    const { data, error } = await supabase
      .from("user_tour_access")
      .select("tour_id, expires_at, access_code, granted_at")
      .eq("email", email)
      .in("tour_id", tourIds)

    if (error) {
      console.error("Error checking user access:", error)
      return res.status(500).json({
        success: false,
        message: "Failed to check user access",
      })
    }

    // Filter out expired access
    const now = new Date()
    const validAccess = (data || []).filter((item) => {
      const isExpired = isAccessExpired(item.expires_at)
      return !isExpired
    })

    res.json({
      success: true,
      access: validAccess,
    })
  } catch (error) {
    console.error("Check user access failed:", error)
    res.status(500).json({
      success: false,
      message: "Failed to check user access",
    })
  }
})

// Function to send virtual tour access email - UPDATED WITH EXPIRATION INFO
async function sendVirtualTourAccessEmail(payment, receiptNumber, paymentDetails, expirationTime) {
  const paymentDate = new Date(paymentDetails.paid_at || Date.now()).toLocaleDateString()
  const expirationDate = new Date(expirationTime).toLocaleString()

  // Customer access email HTML with 24-hour expiration warning
  const customerHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd;">
      <div style="text-align: center; margin-bottom: 20px;">
        <h1 style="color: #5A8E00;">Virtual Tour Access Granted!</h1>
        <p>Receipt #: ${receiptNumber}</p>
      </div>
      
      <!-- 24-HOUR EXPIRATION WARNING -->
      <div style="background-color: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
        <div style="display: flex; align-items: center; margin-bottom: 10px;">
          <span style="font-size: 20px; margin-right: 10px;">⏰</span>
          <h3 style="color: #856404; margin: 0;">24-Hour Access Period</h3>
        </div>
        <p style="color: #856404; margin: 0; font-weight: bold;">
          Your access expires on: ${expirationDate}
        </p>
        <p style="color: #856404; margin: 5px 0 0 0; font-size: 14px;">
          After expiration, you'll need to purchase access again to view the tour.
        </p>
      </div>
      
      <div style="background-color: #97E12B; background-opacity: 0.1; padding: 20px; border-radius: 10px; margin-bottom: 20px; text-align: center;">
        <h2 style="color: #1A2E0D; margin-top: 0;">Your Access Code</h2>
        <div style="background-color: white; padding: 15px; border-radius: 8px; margin: 10px 0;">
          <span style="font-family: monospace; font-size: 24px; font-weight: bold; color: #5A8E00; letter-spacing: 2px;">
            ${payment.access_code}
          </span>
        </div>
        <p style="color: #1A2E0D; margin-bottom: 0;">
          Use this code to access your virtual tour
        </p>
      </div>
      
      <div style="margin-bottom: 20px;">
        <h2>Tour Details</h2>
        <p><strong>Tour:</strong> ${payment.tour_name}</p>
        <p><strong>Name:</strong> ${payment.first_name} ${payment.last_name}</p>
        <p><strong>Email:</strong> ${payment.email}</p>
        <p><strong>Purchase Date:</strong> ${paymentDate}</p>
        <p><strong>Access Expires:</strong> ${expirationDate}</p>
        <p><strong>Amount Paid:</strong> ₦${payment.amount.toLocaleString()}</p>
        <p><strong>Payment Reference:</strong> ${payment.payment_reference}</p>
      </div>
      
      <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin-top: 20px; border-left: 4px solid #5A8E00;">
        <h2 style="color: #5A8E00; margin-top: 0;">How to Access Your Tour</h2>
        <ol style="padding-left: 20px;">
          <li style="margin-bottom: 10px;">Visit our virtual tour page</li>
          <li style="margin-bottom: 10px;">Click on "${payment.tour_name}"</li>
          <li style="margin-bottom: 10px;">Enter your access code: <strong>${payment.access_code}</strong></li>
          <li style="margin-bottom: 10px;">Enjoy your immersive virtual tour experience!</li>
        </ol>
        
        <div style="margin-top: 20px; padding: 15px; background-color: #fff3cd; border-radius: 5px;">
          <p style="margin: 0; color: #856404;">
            <strong>⚠️ Important:</strong> Your access is valid for 24 hours only. Make sure to enjoy your tour before ${expirationDate}!
          </p>
        </div>
      </div>
      
      <div style="margin-top: 30px; border-top: 1px solid #ddd; padding-top: 20px; text-align: center;">
        <p>Thank you for choosing our virtual tour experience!</p>
        <p>If you have any questions, please contact us at support@experienceplateau.com</p>
      </div>
    </div>
  `

  // Admin notification HTML with expiration info
  const adminHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd;">
      <h1 style="color: #5A8E00;">New Virtual Tour Purchase</h1>
      <p>Receipt #: ${receiptNumber}</p>
      
      <h2>Customer Information</h2>
      <p><strong>Name:</strong> ${payment.first_name} ${payment.last_name}</p>
      <p><strong>Email:</strong> ${payment.email}</p>
      <p><strong>Phone:</strong> ${payment.phone_number}</p>
      
      <h2>Tour Details</h2>
      <p><strong>Tour:</strong> ${payment.tour_name} (ID: ${payment.tour_id})</p>
      <p><strong>Access Code:</strong> ${payment.access_code}</p>
      <p><strong>Access Expires:</strong> ${expirationDate}</p>
      
      <h2>Payment Information</h2>
      <p><strong>Amount:</strong> ₦${payment.amount.toLocaleString()}</p>
      <p><strong>Payment Date:</strong> ${paymentDate}</p>
      <p><strong>Payment Reference:</strong> ${payment.payment_reference}</p>
      <p><strong>Payment Status:</strong> ${payment.payment_status}</p>
      <p><strong>Payment Channel:</strong> ${paymentDetails.channel || "N/A"}</p>
    </div>
  `

  try {
    // Send customer access email
    await client.sendEmail({
      From: process.env.EMAIL_FROM || "bookings@experienceplateau.com",
      To: payment.email,
      Subject: `Your 24-Hour Virtual Tour Access - ${payment.tour_name}`,
      HtmlBody: customerHtml,
      MessageStream: "outbound",
    })

    // Send admin notification
    await client.sendEmail({
      From: process.env.EMAIL_FROM || "bookings@experienceplateau.com",
      To: process.env.ADMIN_EMAIL || "bookings@experienceplateau.com",
      Subject: `New Virtual Tour Purchase: ${payment.tour_name}`,
      HtmlBody: adminHtml,
      MessageStream: "outbound",
    })

    console.log("Virtual tour access emails sent successfully with expiration info")
  } catch (error) {
    console.error("Error sending virtual tour access emails:", error)
  }
}


app.listen(port, () => {
  console.log(`Server running on port ${port}`)
})

console.log("Video endpoint available at: http://localhost:" + port + "/video")
