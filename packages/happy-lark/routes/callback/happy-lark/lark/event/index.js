export default async function (fastify, opts) {
  fastify.post('/', async function (request, reply) {
    const { type, challenge } = request.body

    if (type === 'url_verification') {
      return { challenge }
    }

    return { ok: true }
  })
}
