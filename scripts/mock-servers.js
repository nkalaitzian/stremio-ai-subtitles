'use strict';

// ---------------------------------------------------------------------------
// Mock servers used by scripts/test.js — no real external services needed.
//   OS port  : emulates api.opensubtitles.com (login / subtitles / download)
//   LLM port : emulates any OpenAI-compatible /chat/completions endpoint
// ---------------------------------------------------------------------------

const express = require('express');

const FIXTURE_SRT = `1
00:00:01,000 --> 00:00:03,000
Hello world

2
00:00:04,000 --> 00:00:06,500
How are you?

3
00:00:07,000 --> 00:00:09,000
See you soon.
`;

const FIXTURE_TRANSLATIONS = ['Γεια σου κόσμε', 'Τι κάνεις;', 'Τα λέμε σύντομα'];

function createOSMock() {
  const app = express();
  app.use(express.json());
  const stats = { loginCalls: 0, searchCalls: 0, downloadCalls: 0, fileFetches: 0 };

  app.post('/api/v1/login', (req, res) => {
    stats.loginCalls++;
    res.json({ token: 'mock-token', status: 200 });
  });

  app.get('/api/v1/subtitles', (req, res) => {
    stats.searchCalls++;
    if (req.query.video_hash === 'deadbeef' || req.query.imdb_id === 'tt0000001') {
      return res.json({
        total_count: 1,
        data: [{
          id: '1',
          type: 'subtitle',
          attributes: {
            subtitle_id: '1',
            language: 'en',
            download_count: 500,
            hearing_impaired: false,
            machine_translated: false,
            files: [{ file_id: 42, file_name: 'sample.srt' }],
          },
        }],
      });
    }
    res.json({ total_count: 0, data: [] });
  });

  app.post('/api/v1/download', (req, res) => {
    stats.downloadCalls++;
    const port = process.env.MOCK_OS_PORT || '8311';
    res.json({
      link: `http://127.0.0.1:${port}/file.srt`,
      file_name: 'sample.srt',
      remaining: 99,
    });
  });

  app.get('/file.srt', (req, res) => {
    stats.fileFetches++;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(FIXTURE_SRT);
  });

  app.get('/stats', (req, res) => res.json(stats));
  return app;
}

function createLLMMock() {
  const app = express();
  app.use(express.json());
  let translateCalls = 0;

  app.post('/v1/chat/completions', (req, res) => {
    translateCalls++;
    res.json({
      id: 'chatcmpl-mock',
      choices: [{ message: { role: 'assistant', content: JSON.stringify(FIXTURE_TRANSLATIONS) } }],
    });
  });

  app.get('/stats', (req, res) => res.json({ translateCalls }));
  return app;
}

module.exports = { createOSMock, createLLMMock, FIXTURE_SRT, FIXTURE_TRANSLATIONS };
