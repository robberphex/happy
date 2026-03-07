import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class MessageDedupeService {
  async tryInsert(messageId) {
    try {
      await prisma.messageDedupe.create({
        data: { messageId },
      });
      return true;
    } catch (error) {
      if (error.code === 'P2002') {
        console.warn(`Duplicate messageId received: ${messageId}`);
        return false;
      }
      throw error;
    }
  }
}
