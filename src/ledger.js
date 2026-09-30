// 只追加事件账本：事件一旦写入不可修改，只能由后续事件给出新结论。
// 同一 commandId 重复提交时返回首次写入的事件，保证重复提交得到一致结果。
export class EventLog {
  constructor(events = []) {
    this._events = events.map((event, index) => ({ seq: index + 1, ...event }));
    this._commands = new Map();
    for (const event of this._events) {
      if (event.command_id) this._remember(event.command_id, event.seq - 1);
    }
  }

  _remember(commandId, index) {
    const seen = this._commands.get(commandId) ?? [];
    seen.push(index);
    this._commands.set(commandId, seen);
  }

  commit(commandId, newEvents) {
    if (commandId && this._commands.has(commandId)) {
      return this._commands.get(commandId).map((i) => this._events[i]);
    }
    const indexes = [];
    for (const event of newEvents) {
      const stored = { ...event, seq: this._events.length + 1 };
      if (commandId) stored.command_id = commandId;
      this._events.push(stored);
      indexes.push(stored.seq - 1);
      if (commandId) this._remember(commandId, stored.seq - 1);
    }
    return indexes.map((i) => this._events[i]);
  }

  hasCommand(commandId) {
    return this._commands.has(commandId);
  }

  get events() {
    return this._events;
  }
}
