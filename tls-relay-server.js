// tls-relay-server.js
import tls from "node:tls";
import net from "node:net";
import fs from "node:fs";
import { argv } from "node:process";

const PORT = 13263;
const CERT_PATH = "./cert.pem";
const KEY_PATH = "./key.pem";

const cert = fs.readFileSync(CERT_PATH);
const key = fs.readFileSync(KEY_PATH);

/*
 Simple wire protocol (client -> server, before streaming):
 [1 byte hostLen][hostLen bytes host][2 bytes port BE]
 After the server reads full header it will open TCP to host:port and pipe.
*/

function readHeader(socket, cb) {
  let headerBuf = Buffer.alloc(0);

  function onData(chunk) {
    headerBuf = Buffer.concat([headerBuf, chunk]);

    if (headerBuf.length < 1) return; // need hostLen
    const hostLen = headerBuf.readUInt8(0);
    const needed = 1 + hostLen + 2;
    if (headerBuf.length < needed) return;

    // extract header
    const host = headerBuf.slice(1, 1 + hostLen).toString("utf8");
    const port = headerBuf.readUInt16BE(1 + hostLen);

    // remaining bytes after header should be kept for piping
    const remaining = headerBuf.slice(needed);
    socket.removeListener("data", onData);
    cb(null, { host, port, remaining });
  }

  socket.on("data", onData);
  socket.on("error", (err) => cb(err));
  socket.on("close", () => cb(new Error("socket closed before header")));
}

const server = tls.createServer({ key, cert }, (socket) => {
  console.log("TLS client connected from", socket.remoteAddress, socket.remotePort);

  readHeader(socket, (err, header) => {
    if (err) {
      console.error("header error:", err);
      socket.end();
      return;
    }
    const { host, port, remaining } = header;
    console.log("Requested connect to:", host, port);

    const remote = net.connect(port, host, () => {
      // if there were buffered bytes after header, forward them
      if (remaining && remaining.length) remote.write(remaining);

      // then pipe rest of data both ways
      socket.pipe(remote);
      remote.pipe(socket);
    });

    remote.on("error", (e) => {
      console.error("remote connect error:", e.message);
      try { socket.destroy(); } catch (e) {}
    });
  });

  socket.on("error", (e) => {
    console.error("socket error:", e.message);
  });
});

server.listen(PORT, () => {
  console.log(`TLS relay listening on port ${PORT}`);
});
