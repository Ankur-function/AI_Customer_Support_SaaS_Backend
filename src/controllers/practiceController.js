// ! Sign Up

import { generateEmbedding } from "../services/aiService";

export const signUp = async(req,res) => {
    try {
        const {firstName,lastName,role,companyName,email,password} = req.body;

        const userExist = await prisma.user.findUnique({where:{email:email}});
        if(userExist) return res.status(400).json({message:'User Already Exists!'});

        const slug = companyName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric characters with hyphens
            .replace(/(^-|-$)+/g, '');   // Trim leading/trailing hyphens
        
        const hashPassword = await bcrypt.hash(password,10);

        const result = await prisma.$transaction(async(tx)=>{

            const organization = await tx.organization.create({
                data:{
                    name:companyName,
                    slug:slug
                }
            });

            const userCreated = await tx.user.create({
                data:{
                    name:`${firstName} ${lastName}`,
                    email,
                    role:'owner',
                    organizationId:organization.id,
                    password:hashPassword
                }
            });

            return {user:userCreated, organization:organization}
        });

        const token = jwt.sign(
            {
                userId: result.user.id,
                organizationId: result.organization.id,
                role: result.user.role
            },
            JWT_SECRET,
            {expiresIn:'1h'}
        );

        res.cookie("token",token);

        const {password,...sanitizedData} = result.user;

        return res.status(201).json({message:'user and organization created succesfully',data:{
            user:sanitizedData,
            organization:result.organization
        }})


    } catch (error) {
        console.error(error);
        return res.status(500).json({message:'Internal Server Error',error:error.message})
    }
}

// ! Sign In

export const signIn = async(req,res) => {
    try {
        const {email,password} = req.body;

        if(!email || !password) {
            return res.status(400).json({message:'please put valid data'});
        }

        const userExists = await prisma.user.findUnique({where:{email:email}});
        if(!userExists) return res.status(400).json({message:'User does not exist!'});

        const isValidPassword = await bcrypt.compare(password,userExists.password);
        if(!isValidPassword) return res.status(400).json({message:'Invalid Credentials'});

        const token = jwt.sign(
            {
                userId:userExists.id,
                organizationId: userExists.organizationId,
                role:userExists.role
            },
            JWT_SECRET,
            {expiresIn:'1h'}
        );

        res.cookie("token",token);

        const {password,...sanitizedUser} = userExists;

        return res.status(200).json({message:'user loggedIn Successfully',data:sanitizedUser});
    } catch (error) {
        console.error(error);
        return res.status(500).json({message:'Internal Server Error',error:error.message})
    }
}

// ! userAuth middleware :-

export const userAuth = async(req,res,next) => {
    try {
        const token = req.cookies.token;
        if(!token){
            return res.status(401).json({message:'Authentication Required , Please login!'});
        }

        const decode = jwt.verify(token,JWT_SECRET);
        if(!decode.userId || !decode.organizationId) {
            return res.status(400).json({message:'Token is malformed/missing'});
        }

        const user = await prisma.user.findUnique({where:{id:decode.userId,organizationId:decode.organizationId},select:{
            id:true,
            role:true,
            organizationId:true
        }});

        if(!user) return res.status(404).json({message:'User not found'});

        req.user = {
            id:user.id,
            organizationId:user.organizationId,
            role:user.role
        }
        next();

    } catch (error) {
        console.error(error);
        return res.status(500).json({message:'Internal Server Error',error:error.message});
    }
}

// ! authorizeRoles middleware :-

export const authorizeRoles = (...allowedRoles) => {
    return (req,res,next) => {
        try {
            if(!req.user) {
                return res.status(500).json({message:'Intenal Error ,authorizeRoles must be chained after userAuth'});
            }

            if(!allowedRoles.includes(req.user.role)){
                return res.status(403).json({message:'Access Denied: You do not have access for this api'});
            }

            next()
        } catch (error) {
                console.error(error);
                return res.status(500).json({message:'RBAC Middleware error'})
        }
    }
}

const {Queue} = 'bullmq';

export const inviteMember = async (req,res) => {
    try {
        const {email,targetRole} = req.body;
        const {organizationId,role:requestorRole} = req.user;

        if(!email){
            return res.status(400).json({message:'Email is required to send invitation link'});
        }
        if(targetRole === 'owner'){
            return res.status(400).json({message:'target role can not be owner'});
        }
        if(targetRole === 'admin' && requestorRole !== 'owner' ){
            return res.status(400).json({message:'requestor role must be owner'});
        }
        const userExists = await prisma.user.findUnique({
            where:{
                email,
                organizationId
            }
        });
        if(userExists) return res.status(500).json({message:'User is already a member in this organization'});

        const inviteToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date();

        const data = await prisma.invitation.upsert({
            where:{
                email_organizationId:{
                    email,
                    organizationId
                }
            },
            update:{
                token:inviteToken,
                role:role || 'agent',
                expiresAt:expiresAt
            },
            create:{
                token:inviteToken,
                role:role || 'agent',
                email:email,
                organizationId:organizationId,
                expiresAt:expirestAt
            }
        });

        const invitationLink = `${process.env.FRONTEND_URL}/access-token?=${data.token}`
        
        const emailQueue = new Queue({
            // redis connection here
        });
        await emailQueue.add('send-email',{
            email:data.email,
            companyName:data.organization.name,
            invitationLink,
            expiresAt
        });

        return res.status(200).json({
            message:'data fetched successfully',
            data: {
                email:data.email,
                role:data.role,
                token:data.token
            }
        })

    } catch (error) {
        
    }
}

const acceptInvite = async(req,res) => {
    const {firstName,lastName,token,password} = req.body
    if(!firstName || !lastName || !token || !password){
        return res.status(400).json({message:'these fields are required and can not be empty'});
    }
    const tokenExists = await prisma.invitation.findUnique({
        where:{
            token
        }
    });
    if(!tokenExists) return res.status(400).json({message:'Token is Invalid or Expired'});

    const date = new Date();
    if(tokenExists.expiresAt<date) {
        await prisma.invitation.delete({where:{id:tokenExists.id}});
        return res.status(400).json({message:'Token has expired'});
    }

    const hashPassword = await bcrypt.hash(password,10);

    const newAgent = await prisma.$transaction(async(tx)=>{

        const user = await tx.user.create({
            email:tokenExists.email,
            password:hashPassword,
            firstName,
            lastName,
            role:tokenExists.role || 'agent',
            organizationId:tokenExists.organizationId
        });

        await tx.invitation.delete({where:{id:tokenExists.id}});

        return user;
    });

    const {password,...sanitizedUser} = newAgent;

    return res.status(201).json({message:'user created',data:sanitizedUser})

}

export const getMembers = async(req,res)=>{
    const {organizationId} = req.body;

    if(!organizationId) return res.status(400).json({message:'OrganizationId is required'});

    const users = await prisma.users.findMany({where:{organizationId:organizationId},select:{id:true,firstName:true,lastName:true}});

    return res.status(200).json({message:'Members fetched successfully',data:users})
}

export const updateMemberRole = async(req,res)=> {
    const {id:targetUserId} = req.params;
    const {role:newRole} = req.body;

    const {organizationId,role:requestorRole,id:requesterId} = req.user;

    if(!targetUserId) return res.status(400).json({message:'target user id is required'});
    if(!newRole) return res.status(400).json({message:'new role is required'});

    const targetUserExists = await prisma.user.findUnique({where:{id:targetUserId,organizationId}});
    if(!targetUserExists) return res.status(500).json({message:'Target user does not exist in this organization!'});

    if(newRole === 'owner') return res.status(400).json({message:'new role must not be owner'});

    if(newRole === 'admin' && requestorRole !== 'owner'){
        return res.status(400).json({message:'only owner can update role to admin'});
    }

    if(requesterId === targetUserId){
        return res.status(400).json({message:'requestor can not update himself'});
    }

    if(targetUserExists.role === 'owner'){
        return res.status(400).json({message:'no one can update the role of owner'});
    }


    const userUpdate = await prisma.user.update({
        where:{id:targetUserId},
        data:{role:newRole},
        select:{firstName:true,lastName:true,role:true,id:true}
    })

    return res.status(200).json({
            message: "User role modified successfully.",
            data: updatedUser
        });

}

export const deleteMember = async(req,res)=>{
    try {
        const {id:targetUserId} = req.params;
        const {organizationId,role:requesterRole} = req.user;

        const targetUserExists = await prisma.user.findUnique({where:{id:targetUserId,organizationId}});
        if(!targetUserExists) return res.status(500).json({message:'Target user does not exist in this organization!'});

        if(targetUserExists.role === 'owner') return res.status(500).json({message:'owner can not be deleted!'});

        if(targetUserExists.role === requesterRole) return res.status(500).json({message:'access denied: same target user role and requester role can not be deleted'});

        if(targetUserExists.organizationId !== organizationId) return res.status(400).json({message:'Access Denied: you can not delete other organization member'});

        const deleteUser = await prisma.user.delete({where:{id:targetUserId}})

         return res.status(200).json({
            message: `User account associated with ${targetUser.email} has been successfully offboarded and deleted.`
        });

    } catch (error) {
        
    }
}

export const createCustomerTicket = async(req,res) => {
    const {email,body,subject,name,organizationId} = req.body;
    if(!email || !body || !subject || !name || !organizationId) {
        return res.status(400).json({message:'email,body,subject,name and organizationId, all fields are required'});
    }

    const result = await prisma.$transaction(async(tx)=>{
        
        const customer = tx.customer.upsert({
            where:{
                email_organizationId:{
                    email,
                    organizationId
                }
            },
            update:{
                name,
                pnone
            },
            create:{
               data:{ name,
                email,
                organizationId,
                phone
               }
            }
        });

        const ticket = tx.ticket.create({
           data:{ organizationId,
            customerId:customer.id,
            subject,
            status:'OPEN',
            priority:'MEDIUM'
           }
        });

        const message = tx.message.create({
            data:{
                ticketId:ticket.id,
                body,
                senderType:'CUSTOMER',
                senderId:customer.id
            }
        });

        return {customer,ticket,message}
    });

    return res.status(201).json({message:'Conversation Intialize Successfully',data:{
        ticketId:result.ticket.id,
        customerId:result.customer.id
    }})
}

export const getTicketHistory = async(req,res) => {
    const {id:ticketId} = req.params;
    if(!ticketId) return res.status(400).json({message:'Ticket Id is required'});

    const ticketData = await prisma.ticket.findUnique({
        where:{id:ticketId},
        include:{
            customer:{
                select:{
                    name:true,
                    email:true
                }
            },
            message:{
                select:{
                     id: true,
                    body: true,
                    senderType: true,
                    senderId: true,
                    createdAt: true
                }
            }
        }
    });

    if(!ticketData) return res.status(404).json({message:'Ticket thread not found'});

    return res.status(200).json({message:'ticket data fetched successfully',data:ticketData})
}

export const getAgentTickets = async(req,res)=>{
    const {organizationId} = req.user;
    const {status,priority} = req.query;

    const allTickets = await prisma.ticket.findMany({
        where:{
            organizationId,
            status:status.toUpperCase(),
            priority:priority.toUpperCase()
        },
        include:{
            customer:{
                select:{
                name: true, email: true
                }
            },
            assignTo:{
                select:{
                name: true, role: true, id: true
                }
            }
        }
    });

    if(!allTickets) return res.status(404).json({message:'No tickets found for this organization'});

    res.status(200).json({message:'all tickets fetched successfully',data:allTickets});
}

export const getAgentTicketById = async(req,res)=>{
    const {id:ticketId} = req.params;
    const {organizationId} = req.user;

    if(!ticketId) return res.status(404).json({message:'Ticket Id is required'});

    const ticketData = await prisma.ticket.findUnique({
        where:{id:ticketId},
        include:{
            customer:true,
            assignTo:{
                select:{
                    name:true,
                    role:true,
                    email:true,
                    id:true
                }
            }
        }
    });

    if(!ticketData) return res.status(404).json({message:'no ticket found with this id'});

    if(ticketData.organizationId != organizationId) return res.status(500).json({message:'Access Denied: cross organization data detected'});

    return res.status(200).json({message:'data fetched',data:ticketData});
}

export const assignTicket = async(req,res) => {
    const {id:ticketId} = req.params;
    const {userId:targetUserId} = req.body;
    const {id:requesterId,role:requesterRole,organizationId} = req.user;

    if(!ticketId || !targetUserId) return res.status(400).json({message:'ticket id and target uesr id are missing'});

    const ticketDetails = await prisma.ticket.findUnique({where:{id:ticketId}});
    if(!ticketDetails) return res.status(400).json({message:'No ticket found'});

    if(ticketDetails.organizationId !== organizationId) return res.status(500).json({message:'Access Denied: cross organization leak detected'});

    const targetUserDetails = await prisma.user.findUnique({where:{id:targetUserId}});
    if(!targetUserDetails) return res.status(400).json({message:'target user not found'});

    if(!targetUserDetails.organizationId !== organizationId) return res.status({message:'Access Denied: cross organization data leak'});

    if(targetUserDetails.role === 'owner' && requesterRole != 'owner') return res.status(500).json({message:'only owner can assign ticket to themselves'});

    if(targetUserDetails.role === 'admin' && requesterRole === 'agent') return res.status(500).json({message:'agent can not assign tickets to admin'});

    const updatedTicket = await prisma.ticket.update({
        where:{id:ticketId},
        data:{
            assignedUserId:targetUserId,
            status:'IN_PROGRESS'
        },
        include:{
            assignTo:{
                select:{
                    name:true,
                    role:true
                }
            }
        }
    });

    return res.status(201).json({message:'ticket assinged successfully',data:updatedTicket})

    }

    export const updateTicketStatus = async(req,res)=>{
        const {id:ticketId}=req.params;
        const {status}=req.body;
        const {organizationId,role:requesterRole,id:requesterId}=req.user;

        if(!ticketId || !status) return res.status(404).json({message:'ticket id and status are required'});

        const validStatus = ['OPEN','IN_PROGRESS','CLOSED'];
        if(!validStatus.includes(status.toUpperCase())) return res.status(400).json({message:'please enter valid status'});

        const ticketDetails = await prisma.ticket.findUnique({where:{id:ticketId}});
        if(!ticketDetails) return res.status(400).json({message:'ticket not found'});

        if(ticketDetails.organizationId !== organizationId) return res.status(500).json({message:'Access Denied: cross organization data leak detected'});

        if(ticketDetails.assignTo){
           const assignedUserId = assingTo.id;
           const assignRole = assignTo.role;

           if(assignRole ==='owner' && requesterRole !== 'owner') return res.status(500).json({message:'Access Denied:'});
           if(assignRole ==='admin' && requesterRole === 'agent') return res.status(500).json({message:'Access Denied:'});
        }

        const updatedTicket = await prisma.ticket.update({
            where:{id:ticketId},
            data:{
                status:status.toUpperCase()
            }
        });

        return res.status(200).json({ 
            message: `Ticket status successfully advanced to ${updatedTicket.status}`, 
            data: updatedTicket 
        });
    }

    export const createDocument = async(req,res) => {
        try {
            const {title,content,category,isPublished} = req.body;
            const {organizationId,id:userId} = req.user;

            if(!title || !category || !content){
                return res.status(400).json({message:'these fields are required'});
            }

            const embeddingVector = await generateEmbedding(content);
            const vectorString = `[${embeddingVector.join(',')}]`;
            const newDocId = crypto.randomUUID();

            await prisma.queryRaw`
                INSERT INTO "Document"(
                    "id", "organizationId", "title", "content", "category", "isPublished", "createdById", "embedding", "createdAt", "updatedAt"
                )VALUES (
                    ${newDocId}, ${organizationId},${title},${content},${category},${isPublished !==undefined ?isPublished:true},${userId},${vectorString}::vector, NOW(), NOW()
                )
            `
            const document = await prisma.document.findUnique({where:{id:newDocId}});
            return res.status(201).json({message:'created',data:document})
        } catch (error) {
            return res.status(500).json({message:'Internal Server Error'})
        }

    }

    export const getAllDocuments = async(req,res) => {
        try {
            const {organizationId} = req.user;
            const {category} = req.query;

            const documents = await prisma.document.findMany({
                where:{organizationId,category},
                include:{createdBy:{select:{name:true,role:true}}},
                orderBy:{createdBy:'desc'}
            });

            return res.status(200).json({})
        } catch (error) {
            
        }
    }

    export const udpateDocument = async(req,res) => {
        try {
            const {id:docId} = req.params;
            const {title, content, category, isPublished} = req.body;
            const {organizationId} = req.user;

            const document = await prisma.document.findUnique({where:{id:docId}});
            if(!document || document.organizationId !== organizationId){
                return res.status(400).json()
            }

            const targetContent = content || document.content;

            if(content && content !== document.content){
                const embeddingVector = await generateEmbedding(targetContent);
                const vectorString = `[${embeddingVector.join(',')}]`;

                await prisma.queryRaw`
                    UPDATE "Document"
                    SET "embedding" = ${vectorString}::vector
                    where id = ${docId}
                `
            }

            const updateDocument = await prisma.document.update({
                where:{id:docId},
                data:{
                    title:title || document.title,
                    content:targetContent,
                    category:category || document.category,
                    isPublished: isPublished !== undefined ? isPublished:document.isPublished
                }
            });

            return res.status(200).json()
        } catch (error) {
            return res.status(500).json({message:''})
        }
    }

    export const deleteDocument = async(req,res) => {
        const {id:docId} = req.params;
        const {organizationId} = req.user;

        const document = await prisma.document.findUnique({where:{id:docId}});
        if(!document || document.organizationId !== organizationId){
            return res.status(400).json({message:'Invalid'})
        }

        await prisma.document.delete({where:{id:docId}});
        return res.status(400).json({message:'Document deleted successfully'})
    }

    export const uploadPdfDocument = async(req,res) => {
        const {category} = req.body;
        const {organizationId,id:userId} = req.user;

        if(!req.file){
            return res.status(400).json({message:'No Pdf document present'})
        }
        if(!category){
            return res.status(400).json({message:'category field is required'})
        }

        let extractData;
        try {
            extractData = await pdfParse(req.file.buffer)
        } catch (error) {
            console.error('error in pdf parsing',error)
        }

        const rawContent = extractData.text?extractData.text.trim(''):'';
        if(!rawContent) return res.status(400).json({message:'could not extract any clean text from this'})

        const formattedTitle = req.file.originalName;

        const embeddingVector = await generateEmbedding(rawContent);
        const vectorString = `[${embeddingVector.join(',')}]`;
        const newDocId = crypto.randomUUID();

        await prisma.$queryRaw`
            INSERT INTO "Document" (
                "id","organizationId","title","content","category","isPublished","createdById","embedding","createdAt","updatedAt"
            ) VALUES (
                ${newDocId},${organizationId},${formattedTitle},${rawContent},true,${userId},${vectorString}::vector,NOW,NOW 
            )
        `;

        const newDocument = await prisma.document.findUnique({id:newDocId});

        return res.status(201).json({message:'created',data:newDocument})
    }

    

// 3) NOTE :- jab bhi backend ki koi bhi api banao to pehle planning kar lo . ki kya kya hoga api me step by step ki kya kya validation
// 3)         check karenge , kya kya fetch ,create etc. karna hoga sab kuch pen and paper pe .uske baad hi code karo.

// ! Note :- After completing this project visit again the api creation video of Namaste Node.js lectures. and see how akshay saini plans things out before writing api.