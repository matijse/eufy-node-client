import { createSocket, Socket } from 'dgram';
import { Address } from './models';
import { sendMessage, RequestMessageType, hasHeader, ResponseMessageType } from './message.utils';
import {
  buildCheckCamPayload,
  intToBufferLE,
  intToBufferBE,
  buildIntCommandPayload,
  buildIntStringCommandPayload,
} from './payload.utils';
import { CommandType } from './command.model';

export class DeviceClientService {
  private readonly MAGIC_WORD = 'XZYH';

  private addressTimeoutInMs = 3 * 1000;
  private socket: Socket;
  private connected = false;
  private seqNumber = 0;
  private seenSeqNo: {
    [dataType: string]: number;
  } = {};

  private currentControlMessageBuilder: Record<number, Buffer> = {};

  constructor(private address: Address, private p2pDid: string, private actor: string) {
    this.socket = createSocket('udp4');
    this.socket.bind(0);
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public async connect(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;

      this.socket.once('message', (msg) => {
        if (hasHeader(msg, ResponseMessageType.CAM_ID)) {
          console.log('connected!');
          if (!!timer) {
            clearTimeout(timer);
          }
          this.socket.on('message', (msg) => this.handleMsg(msg));
          this.connected = true;
          resolve(true);
        }
      });

      this.sendCamCheck();
      timer = setTimeout(() => {
        reject(`Timeout on connect to ${JSON.stringify(this.address)}`);
      }, this.addressTimeoutInMs);
    });
  }

  private sendCamCheck(): void {
    const payload = buildCheckCamPayload(this.p2pDid);
    sendMessage(this.socket, this.address, RequestMessageType.CHECK_CAM, payload);
  }

  public sendPing(): void {
    sendMessage(this.socket, this.address, RequestMessageType.PING);
  }

  public sendCommandWithIntString(commandType: CommandType, value: number, channel = 0): void {
    // SET_COMMAND_WITH_INT_STRING_TYPE = msgTypeID == 10
    const payload = buildIntStringCommandPayload(value, this.actor, channel);
    this.sendCommand(commandType, payload);
  }

  public sendCommandWithInt(commandType: CommandType, value: number): void {
    // SET_COMMAND_WITH_INT_TYPE = msgTypeID == 4
    const payload = buildIntCommandPayload(value, this.actor);
    this.sendCommand(commandType, payload);
  }

  private sendCommand(commandType: CommandType, payload: Buffer): void {
    // Command header
    const msgSeqNumber = this.seqNumber++;
    const dataTypeBuffer = Buffer.from([0xd1, 0x00]);
    const seqAsBuffer = intToBufferBE(msgSeqNumber, 2);
    const magicString = Buffer.from(this.MAGIC_WORD);
    const commandTypeBuffer = intToBufferLE(commandType, 2);
    const commandHeader = Buffer.concat([dataTypeBuffer, seqAsBuffer, magicString, commandTypeBuffer]);
    const data = Buffer.concat([commandHeader, payload]);
    console.log(`Sending commandType: ${CommandType[commandType]} (${commandType}) with seqNum: ${msgSeqNumber}...`);
    sendMessage(this.socket, this.address, RequestMessageType.DATA, data);
    // -> NOTE:
    // -> We could wait for an ACK and then continue (sync)
    // -> Python impl creating an array an putting an "event" behind a seqNumber
    // -> ACK-Listener triggers the seq-number and therefore showing that the message
    // -> is done, until then the promise is waiting (await)
  }

  private handleMsg(msg: Buffer): void {
    if (hasHeader(msg, ResponseMessageType.PONG)) {
      // Response to a ping from our side
      console.log('GOT PONG');
      return;
    } else if (hasHeader(msg, ResponseMessageType.PING)) {
      // Response with PONG to keep alive
      sendMessage(this.socket, this.address, RequestMessageType.PONG);
      return;
    } else if (hasHeader(msg, ResponseMessageType.END)) {
      // Connection is closed by device
      console.log('GOT END');
      this.connected = false;
      this.socket.close();
      return;
    } else if (hasHeader(msg, ResponseMessageType.CAM_ID)) {
      // Answer from the device to a CAM_CHECK message
      return;
    } else if (hasHeader(msg, ResponseMessageType.ACK)) {
      // Device ACK a message from our side
      // Number of Acks sended in the message
      const numAcksBuffer = msg.slice(6, 8);
      const numAcks = numAcksBuffer.readUIntBE(0, numAcksBuffer.length);
      for (let i = 1; i <= numAcks; i++) {
        const idx = 6 + i * 2;
        const seqBuffer = msg.slice(idx, idx + 2);
        const ackedSeqNo = seqBuffer.readUIntBE(0, seqBuffer.length);
        // -> Message with seqNo was received at the station
        console.log(`ACK for seqNo: ${ackedSeqNo}`);
      }
    } else if (hasHeader(msg, ResponseMessageType.DATA)) {
      const seqNo = msg[6] * 256 + msg[7];
      const dataTypeBuffer = msg.slice(4, 6);
      const dataType = this.toDataTypeName(dataTypeBuffer);

      if (this.seenSeqNo[dataType] !== undefined && this.seenSeqNo[dataType] >= seqNo) {
        // We have already seen this message, skip!
        // This can happen because the device is sending the message till it gets a ACK
        // which can take some time.
        return;
      }
      this.seenSeqNo[dataType] = seqNo;

      console.log(`Processing ${dataType} with seq ${seqNo}...`);
      this.sendAck(dataTypeBuffer, seqNo);
      this.handleData(seqNo, dataType, msg);
    } else {
      console.log('GOT unknown msg', msg.length, msg);
    }
  }

  private handleData(seqNo: number, dataType: string, msg: Buffer): void {
    if (dataType === 'CONTROL') {
      this.parseDataControlMessage(seqNo, msg);
    } else if (dataType === 'DATA') {
      const commandId = msg.slice(12, 14).readUIntLE(0, 2); // could also be the parameter type on DATA events (1224 = GUARD)
      const data = msg.slice(24, 26).readUIntLE(0, 2); // 0 = Away, 1 = Home, 63 = Deactivated
      // Note: data === 65420 when e.g. data mode is already set (guardMode=0, setting guardMode=0 => 65420)
      // Note: data ==== 65430 when there is an error (sending data to a channel which do not exist)
      const commandStr = CommandType[commandId];
      console.log(`DATA package with commandId: ${commandStr} (${commandId}) - data: ${data}`);
    } else {
      console.log(`Data to handle: seqNo: ${seqNo} - dataType: ${dataType} - msg: ${msg.toString('hex')}`);
    }
  }

  private parseDataControlMessage(seqNo: number, msg: Buffer) {
    // is this the first message?
    const multiPartMessage = msg.slice(2, 4).compare(Buffer.from([0x04, 0x04])) === 0;
    const lastPartMessage = msg.slice(2, 4).compare(Buffer.from([0x03, 0xa2])) === 0;
    const firstPartMessage = msg.slice(8, 12).toString() === this.MAGIC_WORD;

    if (firstPartMessage) {
      const payload = msg.slice(24);
      this.currentControlMessageBuilder[seqNo] = payload;
      // first part of the message
    } else if (multiPartMessage) {
      const payload = msg.slice(9);
      this.currentControlMessageBuilder[seqNo] = payload;
      // Just append
    } else if (lastPartMessage) {
      // finish message and print
      const payload = msg.slice(9);
      this.currentControlMessageBuilder[seqNo] = payload;

      // sort by keys
      let completeMessage = Buffer.from([]);
      Object.keys(this.currentControlMessageBuilder)
        .sort()
        .forEach((key: string) => {
          completeMessage = Buffer.concat([completeMessage, this.currentControlMessageBuilder[parseInt(key)]]);
        });
      this.currentControlMessageBuilder = {};
      this.handleDataControl(completeMessage.toString());
    }
  }

  private handleDataControl(message: string) {
    console.log('DATA - CONTROL ->', message);
  }

  private sendAck(dataType: Buffer, seqNo: number) {
    const numPendingAcks = 1;
    const pendingAcksBuffer = Buffer.from([Math.floor(numPendingAcks / 256), numPendingAcks % 256]);
    const seqBuffer = Buffer.from([Math.floor(seqNo / 256), seqNo % 256]);
    const payload = Buffer.concat([dataType, pendingAcksBuffer, seqBuffer]);
    sendMessage(this.socket, this.address, RequestMessageType.ACK, payload);
  }

  private toDataTypeName(input: Buffer): string {
    const DATA = Buffer.from([0xd1, 0x00]);
    const VIDEO = Buffer.from([0xd1, 0x01]);
    const CONTROL = Buffer.from([0xd1, 0x02]);
    if (input.compare(DATA) === 0) {
      return 'DATA';
    } else if (input.compare(VIDEO) === 0) {
      return 'VIDEO';
    } else if (input.compare(CONTROL) === 0) {
      return 'CONTROL';
    }
    return 'unknown';
  }
}
