import { randomBytes } from 'crypto';

/**
 * @param {number} size
 * @returns {Promise<Buffer>}
 */
function getRandomBytesAsync(size) {
  return new Promise((resolve, reject) => {
    randomBytes(size, (err, buffer) => {
      if (err) {
        reject(err);
      } else {
        resolve(buffer);
      }
    });
  });
}

/**
 * @param {import('fastify').FastifyInstance} fastify
 * @param {any} opts
 * @returns {Promise<void>}
 */
export default async function (fastify, opts) {
  fastify.post('/', async function (request, reply) {
    console.debug(JSON.stringify(request.body));
    const { header, challenge } = request.body
    const eventType = header?.event_type
    const event = header?.event_type?.startsWith('application.') ? request.body.event : request.body

    console.log(eventType);
    if (eventType === 'url_verification') {
      return { challenge }
    }

    if (eventType === 'application.bot.menu_v6') {
      const { event_key, operator, timestamp } = event
      console.log(`Bot menu clicked: event_key=${event_key}, operator=${operator?.operator_id?.open_id}, timestamp=${timestamp}`)
      return { ok: true };
    } else if (eventType === 'im.message.receive_v1') {
      const content = event.event.message.content;
      const contentText = JSON.parse(content).text;
      const url = URL.parse(contentText);
      const base64PubKey = url.search.substring(1);
      
      return { ok: true };
    }

    const bytes = await getRandomBytesAsync(32);

    return { ok: true, bytes: bytes.toString('base64') }
  })
}
