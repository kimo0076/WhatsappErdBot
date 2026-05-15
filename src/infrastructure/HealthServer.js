'use strict';

const http = require('http');
const db = require('../database/connection');

/**
 * Minimal HTTP health server for Docker/monitoring.
 *
 * GET /health → 200 { status: "ok", uptime, db, memory }
 * GET /ready  → 200 if all critical services are ready
 */

class HealthServer {
  constructor({ port = 3099, host = '0.0.0.0' } = {}) {
    this.port = port;
    this.host = host;
    this._server = null;
    this._startTime = Date.now();
  }

  start() {
    this._server = http.createServer((req, res) => {
      if (req.url === '/health') return this._handleHealth(req, res);
      if (req.url === '/ready') return this._handleReady(req, res);
      res.writeHead(404);
      res.end('not found');
    });

    this._server.listen(this.port, this.host, () => {
      console.log(`Health server listening on ${this.host}:${this.port}`);
    });

    this._server.on('error', (err) => {
      console.error('Health server error:', err.message);
    });

    return this._server;
  }

  _handleHealth(req, res) {
    const uptime = Math.floor((Date.now() - this._startTime) / 1000);
    const mem = process.memoryUsage();

    const body = {
      status: 'ok',
      uptime_seconds: uptime,
      memory_mb: Math.round(mem.heapUsed / 1024 / 1024),
      memory_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      node_version: process.version,
      pid: process.pid,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  _handleReady(req, res) {
    try {
      // Verify DB connectivity
      const main = db.getMain();
      main.prepare('SELECT 1').get();
      const products = db.getProducts();
      products.prepare('SELECT 1').get();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ready', db: 'connected' }));
    } catch (err) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'not_ready', db: err.message }));
    }
  }

  stop() {
    if (this._server) {
      this._server.close();
      this._server = null;
    }
  }
}

module.exports = HealthServer;
