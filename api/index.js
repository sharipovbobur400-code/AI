'use strict';
// Vercel Serverless Function: every /api/* request (REST, Telegram webhook, cron) is handled here.
// Static files (public/) are served by Vercel's CDN — see vercel.json.
module.exports = require('../server/serverless.js');
