import { Server } from 'socket.io';
import prisma from '../../db.js';
import { generateEmbedding, searchKnowledgeBase, generateGroundedResponse } from '../services/aiService.js';

let io = null;

export const initSocket = (server) => {
    // Initialize the Socket.io server instance attached to our HTTP server
    io = new Server(server, {
        cors: {
            origin: "*", // In production, replace with your specific frontend URLs
            methods: ["GET", "POST"]
        }
    });

    console.log("🔌 Real-Time WebSocket Server Initialized Successfully.");

    // The primary connection event wrapper
    io.on('connection', (socket) => {
        console.log(`📡 New WebSocket client linked: ${socket.id}`);

        // 1. Client joins a unique, isolated ticket conversation room channel whenever he click on any ticket
        socket.on('join_ticket_room', ({ ticketId }) => {

            if (!ticketId) return;
            
            socket.join(`ticket_${ticketId}`);
            console.log(`🚪 Client socket [${socket.id}] joined room: ticket_${ticketId}`);
        });

        // 2. Real-time message streaming listener
        socket.on('send_message', async ({ ticketId, body, senderType, senderId }) => {
            try {
                // Validation fallback
                if (!ticketId || !body || !senderType || !senderId) {
                    return socket.emit('error_message', { message: "Invalid payload parameters sent to stream." });
                }

                // STEP A: Atomic database insertion into our Prisma Message table
                const savedMessage = await prisma.message.create({
                    data: {
                        ticketId,
                        body,
                        senderType, // CUSTOMER, AGENT, or AI
                        senderId
                    }
                });

                // STEP B: Update the parent ticket's updatedAt timestamp so the agent queue sorts dynamically
                await prisma.ticket.update({
                    where: { id: ticketId },
                    data: { updatedAt: new Date() }
                });

                // STEP C: Broadcast the fresh message payload instantly to everyone sitting inside this specific room
                io.to(`ticket_${ticketId}`).emit('receive_message', savedMessage);
                
                console.log(`✉️ Message saved & streamed in room ticket_${ticketId} by ${senderType}`);

                // ◄--- 🚀 NEW AI AUTO-RESPONSE FLOW 🚀 ---►
                if (senderType === 'CUSTOMER') {
                    // Run the AI generation in the background so we don't block the user's WebSocket thread
                    (async () => {
                        try {
                            console.log(`🤖 [AI Engine] Intercepted customer query in room ticket_${ticketId}. Fetching context...`);

                            // 1. Fetch the ticket information to gather the correct organizationId context
                            const parentTicket = await prisma.ticket.findUnique({
                                where: { id: ticketId },
                                select: { organizationId: true }
                            });

                            if (!parentTicket) return;

                            // 2. Generate vector coordinates from the customer's question text string
                            const queryVector = await generateEmbedding(body);

                            // 3. Search our PostgreSQL pgvector store for the top 2 matching context snippets
                            const contextChunks = await searchKnowledgeBase(parentTicket.organizationId, queryVector);

                            // 4. Send snippets and query to Gemini LLM to generate a safe, grounded support response
                            const aiAnswer = await generateGroundedResponse(body, contextChunks);

                            // 5. Commit the generated AI text into the Message timeline ledger
                            const savedAIMessage = await prisma.message.create({
                                data: {
                                    ticketId,
                                    body: aiAnswer,
                                    senderType: 'AI',
                                    senderId: 'SYSTEM_GEMINI_BOT' // Arbitrary system ID tag for your UI styling
                                }
                            });

                            // 6. Broadcast the AI's response to the room in real time!
                            io.to(`ticket_${ticketId}`).emit('receive_message', savedAIMessage);
                            console.log(`🤖 [AI Engine] Successfully streamed automated reply in room ticket_${ticketId}`);

                        } catch (aiError) {
                            console.error("Background AI Engine Processing Failure:", aiError.message);
                        }
                    })();
                }

            } catch (error) {
                console.error("WebSocket Message Save Error:", error);
                socket.emit('error_message', { message: "Message could not be saved to database timeline." });
            }
        });

        // 3. Client disconnect cleanup handler
        socket.on('disconnect', () => {
            console.log(`❌ Client socket unlinked: ${socket.id}`);
        });
    });

    return io;
};

// Exportable helper method so we can push notifications from standard HTTP controllers if needed later
export const getIO = () => {
    if (!io) {
        throw new Error("Socket.io has not been initialized yet!");
    }
    return io;
};