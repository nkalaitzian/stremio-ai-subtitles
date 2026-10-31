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

const FRENCH_SRT = `1
00:00:01,000 --> 00:00:03,000
Bonjour tout le monde

2
00:00:04,000 --> 00:00:06,500
Comment ça va ?

3
00:00:07,000 --> 00:00:09,000
À bientôt
`;

const FIXTURE_TRANSLATIONS = ['Γεια σου κόσμε', 'Τι κάνεις;', 'Τα λέμε σύντομα'];

function createOSMock() {
  const app = express();
  app.use(express.json());
  const stats = { loginCalls: 0, searchCalls: 0, downloadCalls: 0, fileFetches: 0, searches: [] };

  app.post('/api/v1/login', (req, res) => {
    // The addon no longer logs in (the Api-Key is enough), but keep this
    // endpoint to mirror the real API for completeness.
    stats.loginCalls++;
    if (req.headers['api-key'] === 'bad-key') {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    res.json({ token: 'mock-token', status: 200 });
  });

  app.get('/api/v1/subtitles', (req, res) => {
    stats.searchCalls++;
    const q = req.query;
    stats.searches.push({
      moviehash: q.moviehash,
      moviebytesize: q.moviebytesize,
      imdb_id: q.imdb_id,
      parent_imdb_id: q.parent_imdb_id,
      season_number: q.season_number,
      episode_number: q.episode_number,
      languages: q.languages,
      type: q.type,
    });
    // Like the real API, an invalid Api-Key is rejected on search too.
    if (req.headers['api-key'] === 'bad-key') {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    // The real API needs at least one real search parameter.
    if (!q.moviehash && !q.imdb_id && !q.parent_imdb_id) {
      return res.status(400).json({ message: 'Missing search parameters' });
    }
    const matched = q.moviehash === 'deadbeef'
      || q.imdb_id === '1'
      || (q.parent_imdb_id === '2' && q.season_number === '3' && q.episode_number === '4');
    if (!matched) return res.json({ total_count: 0, data: [] });
    return res.json({
      total_count: 3,
      data: [
        {
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
        },
        {
          id: '2',
          type: 'subtitle',
          attributes: {
            subtitle_id: '2',
            language: 'en',
            download_count: 100,
            hearing_impaired: true,
            machine_translated: false,
            files: [{ file_id: 44, file_name: 'sample2.srt' }],
          },
        },
        {
          id: '3',
          type: 'subtitle',
          attributes: {
            subtitle_id: '3',
            language: 'fr',
            download_count: 300,
            hearing_impaired: false,
            machine_translated: false,
            files: [{ file_id: 43, file_name: 'sample.fr.srt' }],
          },
        },
      ],
    });
  });

  app.post('/api/v1/download', (req, res) => {
    stats.downloadCalls++;
    const port = process.env.MOCK_OS_PORT || '8311';
    // The real download endpoint accepts the Api-Key alone (no login).
    if (req.headers['api-key'] === 'bad-key') {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const fileId = req.body && req.body.file_id ? req.body.file_id : 0;
    if (fileId === 999) {
      return res.status(407).json({ message: 'Download limit reached' });
    }
    res.json({
      link: `http://127.0.0.1:${port}/file.srt?fileId=${fileId}`,
      file_name: 'sample.srt',
      remaining: 99,
    });
  });

  app.get('/file.srt', (req, res) => {
    stats.fileFetches++;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(req.query.fileId === '43' ? FRENCH_SRT : FIXTURE_SRT);
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
    let count = FIXTURE_TRANSLATIONS.length;
    try {
      const user = (req.body.messages || []).find((m) => m.role === 'user');
      count = JSON.parse(user.content).length;
    } catch (e) { /* keep default */ }
    const out = Array.from({ length: count }, (_, i) => FIXTURE_TRANSLATIONS[i % FIXTURE_TRANSLATIONS.length]);
    res.json({
      id: 'chatcmpl-mock',
      choices: [{ message: { role: 'assistant', content: JSON.stringify(out) } }],
    });
  });

  app.get('/stats', (req, res) => res.json({ translateCalls }));
  return app;
}

module.exports = { createOSMock, createLLMMock, FIXTURE_SRT, FRENCH_SRT, FIXTURE_TRANSLATIONS };
