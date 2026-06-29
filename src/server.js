import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import http from 'http'; // Native Node.js module
import { initSocket } from './config/socket.js';
import cookieParser from 'cookie-parser';
import prisma  from '../db.js'; // Imports your Prisma Client from db.js
import authRouter from './routes/authRoute.js';
import profileRouter from './routes/profileRoute.js';
import memberRouter from './routes/memberRoute.js'
import customerTicketRouter from './routes/cutomerTicketsRoute.js'
import agentTicketRouter from './routes/agentTicketsRoute.js'
import documentRouter from './routes/kbRoute.js'
import cors from 'cors';
 
// Inside server.js
import '../src/workers/emailWorker.js'; // Starts the background thread process

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: 'http://localhost:5173', // Allow your exact Vite frontend server to talk to us
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'], // Allow these request types
  allowedHeaders: ['Content-Type', 'Authorization'], // ◄--- THIS FIXES YOUR ERROR EXPLICITLY!
  credentials: true // Allows HTTP cookies/headers to transfer across endpoints smoothly
}));

// Middleware to parse incoming JSON payloads
app.use(express.json());
app.use(cookieParser())

// 1. Wrap the Express app inside a native HTTP Server instance
const server = http.createServer(app);

// 2. Initialize our WebSocket event layer
initSocket(server);


// --- ROUTES ---
app.use('/',authRouter);
app.use('/profile',profileRouter)
app.use('/members',memberRouter)
app.use('/customer/tickets',customerTicketRouter)
app.use('/agent/tickets', agentTicketRouter);
app.use('/kb',documentRouter)



// Start the Express Server
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
