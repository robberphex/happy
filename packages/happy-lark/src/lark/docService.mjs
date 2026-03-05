export class DocService {
  constructor(larkClient, logger) {
    this.larkClient = larkClient
    this.logger = logger
  }

  async readDocContent(docToken) {
    this.logger.info(`Reading doc: ${docToken}`)
    return this.larkClient.fetchDocContent(docToken)
  }

  async buildDocContext(docToken) {
    if (!docToken) {
      return null
    }
    const content = await this.readDocContent(docToken)
    if (!content) {
      return null
    }
    return `\n--- Document Context ---\n${content}\n--- End Document Context ---\n`
  }
}
