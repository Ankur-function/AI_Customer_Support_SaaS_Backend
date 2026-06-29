import 'dotenv/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

// Connect to your local Dockerized Redis instance
const redisConnection = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: null // Required configuration for BullMQ compatibility
});

export const emailQueue = new Queue('EmailQueue', {
  connection: redisConnection,
});