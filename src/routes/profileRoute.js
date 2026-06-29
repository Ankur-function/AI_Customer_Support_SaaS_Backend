import express from 'express'
import { getProfile } from '../controllers/profileController.js';
import userAuth from '../middleware/userAuth.js';

const profileRouter = express.Router();

profileRouter.get('/view', userAuth,getProfile);
// profileRouter.patch('/edit',userAuth,updateProfile);
// profileRouter.patch('/passwordChange',userAuth,changeProfilePassword)

export default profileRouter