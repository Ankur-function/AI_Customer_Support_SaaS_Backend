import prisma from '../../db.js';

/**
 * POST /api/v1/tickets
 * Public customer endpoint to initialize a support ticket conversation thread
 * creating a ticket by a customer
 */
export const createCustomerTicket = async (req, res) => {
    try {
        const { name, email, phone, subject, body, organizationId } = req.body;

        // 1. Basic validation check
        if (!name || !email || !subject || !body || !organizationId) {
            return res.status(400).json({ 
                message: "Missing parameters. Name, email, subject, body, and organizationId are required." 
            });
        }

        // 2. Execute an atomic transaction to handle profile management and ticket locking safely
        const result = await prisma.$transaction(async (tx) => {
            
            // Step A: Find or create the Customer profile within this specific tenant boundary (Upsert strategy)
            const customer = await tx.customer.upsert({
                where: {
                    email_organizationId: {
                        email: email.toLowerCase().trim(),
                        organizationId
                    }
                },
                update: {
                    name, // Keep their name updated if they changed it
                    phone
                },
                create: {
                    name,
                    email: email.toLowerCase().trim(),
                    phone,
                    organizationId
                }
            });

            // Step B: Create the new master Ticket record
            const ticket = await tx.ticket.create({
                data: {
                    subject,
                    organizationId,
                    customerId: customer.id,
                    status: "OPEN",
                    priority: "MEDIUM" // Default level, can be triaged later
                }
            });

            // Step C: Log the very first message into the message history array
            const firstMessage = await tx.message.create({
                data: {
                    ticketId: ticket.id,
                    body,
                    senderType: "CUSTOMER",
                    senderId: customer.id
                }
            });

            return { customer, ticket, firstMessage };
        });

        // 3. Return response containing the operational ticket identifiers
        return res.status(201).json({
            message: "Support conversation initialized successfully.",
            data: {
                ticketId: result.ticket.id,
                status: result.ticket.status,
                priority: result.ticket.priority,
                customer: {
                    id: result.customer.id,
                    name: result.customer.name,
                    email: result.customer.email
                },
                initialMessage: result.firstMessage.body,
                createdAt: result.ticket.createdAt
            }
        });

    } catch (error) {
        console.error("Create Customer Ticket Error:", error);
        return res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

/**
 * GET /api/v1/tickets/:id
 * Public customer endpoint to fetch a single ticket's metadata and complete message history thread
 * get the single ticket details from customer point of view
 */
export const getTicketHistory = async (req, res) => {
    try {
        const { id: ticketId } = req.params;

        // 1. Fetch the ticket and include all its linked messages sorted by creation time
        const ticketWithHistory = await prisma.ticket.findUnique({
            where: { id: ticketId },
            include: {
                customer: {
                    select: {
                        name: true,
                        email: true
                    }
                },
                messages: {
                    select: {
                        id: true,
                        body: true,
                        senderType: true,
                        senderId: true,
                        createdAt: true
                    },
                    orderBy: {
                        createdAt: 'asc' // Critical: Ensures chat renders from oldest to newest message
                    }
                }
            }
        });

        // 2. Security Check: If the ticket doesn't exist, return a clean 404
        if (!ticketWithHistory) {
            return res.status(404).json({ message: "Support conversation thread not found." });
        }

        // 3. Return the payload to the chat widget frontend
        return res.status(200).json({
            message: "Conversation history synced successfully.",
            data: ticketWithHistory
        });

    } catch (error) {
        console.error("Get Ticket History Error:", error);
        return res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};