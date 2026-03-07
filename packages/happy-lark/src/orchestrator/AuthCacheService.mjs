import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class AuthCacheService {
  /**
   * @param {string} senderId
   * @returns {{ secret: Uint8Array; token: string } | null}
   */
  async get(senderId) {
    const authCache = await prisma.authCache.findUnique({
      where: { senderId },
    });
    if (!authCache) {
      return null;
    }
    return {
      secret: Uint8Array.from(atob(authCache.secret), (c) => c.charCodeAt(0)),
      token: authCache.token,
    };
  }

  /**
   * @returns {Promise<Array<{ senderId: string; secret: Uint8Array; token: string }>>}
   */
  async getAll() {
    const authCaches = await prisma.authCache.findMany();
    return authCaches.map((authCache) => ({
      senderId: authCache.senderId,
      secret: Uint8Array.from(atob(authCache.secret), (c) => c.charCodeAt(0)),
      token: authCache.token,
    }));
  }

  /**
   * @param {string} senderId
   * @param {{ secret: Uint8Array; token: string }} authData
   */
  async set(senderId, authData) {
    await prisma.authCache.upsert({
      where: { senderId },
      update: {
        secret: Buffer.from(authData.secret).toString("base64"),
        token: authData.token,
      },
      create: {
        senderId,
        secret: Buffer.from(authData.secret).toString("base64"),
        token: authData.token,
      },
    });
  }
}
