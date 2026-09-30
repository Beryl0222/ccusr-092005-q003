// 只增事件日志：任何事实变化都只能追加事件，不允许修改或删除历史。
// 撤回、补充证据同样以新事件表达，由投影决定"当前结论"。

let SEQ = 0;

export function nextSeq() {
  SEQ += 1;
  return SEQ;
}

// 测试间复位序号（生产中序号应由持久层单调分配）
export function resetSeq(value = 0) {
  SEQ = value;
}

export class EventLog {
  constructor() {
    this.events = [];
    // 幂等键索引：同一来源对同一对象重复提交同一证据，只产生一条事件
    this.idempotency = new Map();
  }

  append(type, payload = {}, { idempotencyKey = null, at = new Date().toISOString() } = {}) {
    if (idempotencyKey !== null) {
      if (this.idempotency.has(idempotencyKey)) {
        return this.events[this.idempotency.get(idempotencyKey)];
      }
    }
    const event = { seq: nextSeq(), at, type, payload };
    this.events.push(event);
    if (idempotencyKey !== null) {
      this.idempotency.set(idempotencyKey, this.events.length - 1);
    }
    return event;
  }

  [Symbol.iterator]() {
    return this.events[Symbol.iterator]();
  }

  get length() {
    return this.events.length;
  }
}
