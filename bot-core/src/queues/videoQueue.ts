import { Queue } from 'bullmq';
import { connection } from '../lib/redis.js';

export const videoQueue = new Queue('VideoDelivery', { connection });

export async function scheduleVideo(patientId: string, videoUrl: string, delayMs: number) {
  await videoQueue.add('sendVideo', 
    { patientId, videoUrl }, 
    { delay: delayMs }
  );
}