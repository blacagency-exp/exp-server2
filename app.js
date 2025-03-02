require("dotenv").config()
const express = require("express")
const cors = require("cors")
const axios = require("axios")
const { createClient } = require("@supabase/supabase-js")
const postmark = require('postmark');

const app = express()
const port = process.env.PORT || 5000

const nodemailer = require('nodemailer'); 

app.use(cors())
app.use(express.json())

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY
const PAYSTACK_BASE_URL = "https://api.paystack.co"
// Create a client instance with your server token
const client = new postmark.ServerClient(process.env.POSTMARK_SERVER_TOKEN);

// Test route
app.get("/", (req, res) => {
  res.json({ message: "Server is running!" })
})

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
    const { email, first_name, last_name, phone } = req.body;

    const response = await axios.post(
      `${PAYSTACK_BASE_URL}/customer`,
      {
        email,
        first_name,
        last_name,
        phone
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("Customer created on Paystack:", response.data);
    res.json(response.data);
  } catch (error) {
    console.error("Customer creation failed:", error.response ? error.response.data : error.message);
    res.status(500).json({ error: "Failed to create customer", details: error.message });
  }
});

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
          phone: metadata.phone_number
        },
        {
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );
      console.log("Customer created/updated on Paystack:", customerResponse.data);
    } catch (customerError) {
      // Log the error but continue with payment initialization
      console.error("Customer creation failed:", customerError.response ? customerError.response.data : customerError.message);
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

app.get('/test-email-postmark', async (req, res) => {
  try {
    const testBooking = {
      first_name: 'Test',
      last_name: 'User',
      email: 'bookings@experienceplateau.com', // Use your email for testing
      phone_number: '1234567890',
      package_type: 'Premium Tour',
      traveler_type: 'Individual',
      amount: 25000,
      payment_reference: 'TEST-REF-123',
      payment_status: 'completed',
      specific_requests: 'None'
    };
    
    await sendReceiptEmails(
      testBooking, 
      'TEST-RCP-123', 
      { paid_at: new Date(), channel: 'card' }
    );
    
    res.send('Test email sent successfully via Postmark');
  } catch (error) {
    console.error('Email test failed:', error);
    res.status(500).send(`Error: ${error.message}`);
  }
});

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
          .single();
  
          if (bookingError) throw bookingError;
  
                // Generate receipt number
        const receiptNumber = `RCP-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        

         // Update booking with receipt number
      await supabase
      .from("bookings")
      .update({ receipt_number: receiptNumber })
      .eq("payment_reference", reference);

       // Send receipt emails
       await sendReceiptEmails(bookingData, receiptNumber, response.data.data);

       // If a guide was selected, send notification to the guide
      if (bookingData.guide_id) {
        await sendGuideNotification(bookingData, receiptNumber);
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
    const { data, error } = await supabase.from("guides").select("*");

    if (error) {
      console.error("Error fetching guides:", error);
      return res.status(500).json({ error: "Failed to fetch guides" });
    }

    res.json(data);
  } catch (error) {
    console.error("Unexpected error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

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
      .single();
    
    if (guideError) {
      console.error("Error fetching guide data:", guideError);
      return;
    }

    // Format date
    const bookingDate = new Date().toLocaleDateString();
    
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
          ${booking.group_size ? `<p><strong>Group Size:</strong> ${booking.group_size}</p>` : ''}
          <p><strong>Receipt Number:</strong> ${receiptNumber}</p>
          <p><strong>Booking Date:</strong> ${bookingDate}</p>
          <p><strong>Specific Requests:</strong> ${booking.specific_requests || 'None'}</p>
        </div>
        
        <div style="margin-top: 30px; border-top: 1px solid #ddd; padding-top: 20px;">
          <p>Please contact the customer within 24 hours to discuss the details of their tour.</p>
          <p>If you have any questions, please contact our booking team at bookings@experienceplateau.com</p>
        </div>
      </div>
    `;
    
    // Send email to guide
    await client.sendEmail({
      From: process.env.EMAIL_FROM || 'bookings@experienceplateau.com',
      To: guideData.email || 'bookings@experienceplateau.com', // In production, use the actual guide email
      Subject: `New Tour Assignment: ${booking.first_name} ${booking.last_name}`,
      HtmlBody: guideHtml,
      MessageStream: 'outbound'
    });
    
    console.log(`Guide notification email sent to ${guideData.name} (${guideData.email})`);
  } catch (error) {
    console.error('Error sending guide notification email:', error);
    // Continue execution even if email fails
  }
}

// Function to send receipt emails
// Replace your existing sendReceiptEmails function with this:
async function sendReceiptEmails(booking, receiptNumber, paymentDetails) {
  // Format date
  const paymentDate = new Date(paymentDetails.paid_at || Date.now()).toLocaleDateString();
  const testRecipient = 'bookings@experienceplateau.com'; 
  
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
        ${booking.group_size ? `<p><strong>Group Size:</strong> ${booking.group_size}</p>` : ''}
        <p><strong>Amount Paid:</strong> ₦${(booking.amount).toLocaleString()}</p>
        <p><strong>Payment Reference:</strong> ${booking.payment_reference}</p>
      </div>
      
      <div style="margin-top: 30px; border-top: 1px solid #ddd; padding-top: 20px; text-align: center;">
        <p>Thank you for booking with us! We're excited to help you explore Plateau State.</p>
        <p>If you have any questions, please contact us at support@experienceplateau.com</p>
      </div>
    </div>
  `;
  
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
      ${booking.group_size ? `<p><strong>Group Size:</strong> ${booking.group_size}</p>` : ''}
      <p><strong>Specific Requests:</strong> ${booking.specific_requests}</p>
      
      <h2>Payment Information</h2>
      <p><strong>Amount:</strong> ₦${(booking.amount).toLocaleString()}</p>
      <p><strong>Payment Date:</strong> ${paymentDate}</p>
      <p><strong>Payment Reference:</strong> ${booking.payment_reference}</p>
      <p><strong>Payment Status:</strong> ${booking.payment_status}</p>
      <p><strong>Payment Channel:</strong> ${paymentDetails.channel || 'N/A'}</p>
      <p><strong>Payment Method:</strong> ${paymentDetails.authorization?.card_type || 'N/A'}</p>
    </div>
  `;
  
  try {
    // Send customer receipt
    await client.sendEmail({
      From: process.env.EMAIL_FROM || 'bookings@experienceplateau.com',
      To: testRecipient,
      Subject: 'Your Booking Receipt',
      HtmlBody: customerHtml,
      MessageStream: 'outbound'
    });
    
    // Send admin notification
    await client.sendEmail({
      From: process.env.EMAIL_FROM || 'bookings@experienceplateau.com',
      To: process.env.ADMIN_EMAIL || 'bookings@experienceplateau.com',
      Subject: `New Booking: ${booking.first_name} ${booking.last_name}`,
      HtmlBody: adminHtml,
      MessageStream: 'outbound'
    });
    
    console.log('Receipt emails sent successfully via Postmark');
  } catch (error) {
    console.error('Error sending receipt emails:', error);
    // Continue execution even if email fails
  }
}

app.listen(port, () => {
  console.log(`Server running on port ${port}`)
})

