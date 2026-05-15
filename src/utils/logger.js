'use strict';

const winston = require('winston');
require('winston-daily-rotate-file');
const fs = require('fs');

fs.mkdirSync('./logs', { recursive: true });

const fmt = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message }) =>
    `[${timestamp}] ${level.toUpperCase()}: ${message}`
  )
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: fmt,
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        fmt
      ),
    }),
    new winston.transports.DailyRotateFile({
      filename: './logs/app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d',
    }),
    new winston.transports.File({
      filename: './logs/error.log',
      level: 'error',
    }),
  ],
});

module.exports = logger;
