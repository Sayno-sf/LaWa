import { Agent, setGlobalDispatcher } from "undici";

// 连接池调优。实测（美国 → 中国大陆 dashscope 端点的跨境链路）：
// - 新建 TLS 连接在链路劣化时要 5～58 秒（握手包丢包重传）；
// - 空闲连接在网络层几秒内就可能被 NAT 无通知回收，客户端却仍当作活连接复用，
//   把请求发进黑洞后要等约 51 秒 TCP 重传超时——比重新握手更糟。
// 因此空闲连接只保守保留 10 秒（覆盖同一轮 Agent 的连续往返），超过即主动关闭；
// headersTimeout 收紧到 60 秒，让无响应快速失败，而不是无限等待。
// 注意：这只能优化连接行为；跨境链路本身劣化时，应改用海外可达的 Provider。
const keepAliveAgent = new Agent({
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 120_000,
  headersTimeout: 60_000,
  bodyTimeout: 300_000,
  connect: { timeout: 30_000 },
});

setGlobalDispatcher(keepAliveAgent);
