import * as lark from "@larksuiteoapi/node-sdk"

const baseConfig = {
  appId: process.env.LARK_APP_ID,
    appSecret: process.env.LARK_APP_SECRET,
  domain: lark.Domain.Lark
}
const client = new lark.Client(baseConfig);
const wsClient = new lark.WSClient({ ...baseConfig, loggerLevel: lark.LoggerLevel.debug, domain: lark.Domain.Lark });
wsClient.start({
  // 处理「接收消息」事件，事件类型为 im.message.receive_v1
  eventDispatcher: new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      console.log("im.message.receive_v1", data);
      const {
        message: { chat_id, content }
      } = data;
      // 示例操作：接收消息后，调用「发送消息」API 进行消息回复。
      await client.im.v1.message.create({
        params: {
          receive_id_type: "chat_id"
        },
        data: {
          receive_id: chat_id,
          content: lark.messageCard.defaultCard({
            title: `回复： ${JSON.parse(content).text}`,
            content: '新年好'
          }),
          msg_type: 'interactive'
        }
      });
    }
  })
});
