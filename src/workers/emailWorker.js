import { Worker } from 'bullmq';
import Redis from 'ioredis';
import nodemailer from 'nodemailer';

// Connect to the same Docker Redis instance
const redisConnection = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: null // Required configuration for BullMQ compatibility
});

// Configure a Mock Mail Transporter (You can replace this with SendGrid/Resend credentials later)
const transporter = nodemailer.createTransport({
  host: 'smtp.ethereal.email', // Great for local testing without setting up real SMTP keys
  port: 587,
  auth: {
    user: process.env.SMTP_USER || 'mock_user',
    pass: process.env.SMTP_PASSWORD || 'mock_password'
  }
});

// Initialize the Worker
const emailWorker = new Worker('EmailQueue', async (job) => {
  if (job.name === 'send-invite-email') {
    const { email, companyName, invitationLink, expiresAt } = job.data;

    console.log(`[Worker] Processing invitation email for: ${email}`);

    // Compose HTML content
    const htmlContent = `
      <h1>You have been invited to join ${companyName}!</h1>
      <p>Your team administrator has invited you to join their AI Customer Support workspace as a support member.</p>
      <p>Click the link below to set up your password and complete your registration:</p>
      <a href="${invitationLink}" style="padding: 10px 20px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 5px;">Accept Invitation</a>
      <p style="color: red; margin-top: 20px;">Note: This secure link will expire on ${new Date(expiresAt).toLocaleString()}</p>
    `;
    
    // Send the email
    await transporter.sendMail({
      from: '"AI Support SaaS" <noreply@aisupportsaas.com>',
      to: email,
      subject: `Invitation to join ${companyName} Workspace`,
      html: htmlContent
    });

    console.log(`[Worker] Email successfully delivered to ${email}`);
  }
}, {
  connection: redisConnection,
  concurrency: 5 // Process up to 5 emails simultaneously if high traffic hits
});

// Error Event Handling for Monitoring logs
emailWorker.on('failed', (job, err) => {
  console.error(`[Worker Error] Job ${job.id} failed with error: ${err.message}`);
});

export default emailWorker;