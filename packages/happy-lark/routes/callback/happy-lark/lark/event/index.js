import { randomBytes } from 'crypto';

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

export default async function (fastify, opts) {
  fastify.post('/', async function (request, reply) {
    console.debug(JSON.stringify(request.body));
    const { type, challenge } = request.body

    if (type === 'url_verification') {
      return { challenge }
    }

    const bytes = await getRandomBytesAsync(32);

    return { ok: true }
  })
}
