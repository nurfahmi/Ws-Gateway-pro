import { Server } from 'socket.io';

let io = null;

export function initSocketIO(httpServer) {
  io = new Server(httpServer);
  return io;
}

export function getIO() {
  return io;
}
