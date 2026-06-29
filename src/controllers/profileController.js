// import { editValidation } from "../utils/validation.js";
// import bcrypt from 'bcrypt'

export const getProfile = async(req,res)=>{
    try {
        const user = req.user;
        res.status(200).send(user)
    } catch (error) {
        res.status(400).send(`Error: ${error.message}`)
    }
}