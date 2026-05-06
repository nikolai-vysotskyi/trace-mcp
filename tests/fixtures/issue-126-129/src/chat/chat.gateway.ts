import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

@WebSocketGateway({
  namespace: '/chat',
  cors: { origin: '*', credentials: true },
})
export class ChatGateway {
  @WebSocketServer()
  server!: Server;

  @SubscribeMessage('message')
  handleMessage(@MessageBody() text: string, @ConnectedSocket() client: Socket) {
    this.server.to('/chat').emit('message', { from: client.id, text });
  }

  @SubscribeMessage('typing')
  handleTyping() {}
}
