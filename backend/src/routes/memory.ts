import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';

const router = express.Router();
const MEMORY_DIR = process.env.MEMORY_DIR || '/clawdbot/memory';

interface MemoryFile {
  filename: string;
  path: string;
  size: number;
  modified: string;
  content?: string;
}

/**
 * GET /memory - List recent memory files
 */
router.get('/', async (_req, res) => {
  try {
    const files = await fs.readdir(MEMORY_DIR);
    
    // Filter for .md files and get stats
    const memoryFiles: MemoryFile[] = [];
    
    for (const filename of files) {
      if (!filename.endsWith('.md')) continue;
      
      const filePath = path.join(MEMORY_DIR, filename);
      const stats = await fs.stat(filePath);
      
      memoryFiles.push({
        filename,
        path: filePath,
        size: stats.size,
        modified: stats.mtime.toISOString()
      });
    }
    
    // Sort by modification time (newest first)
    memoryFiles.sort((a, b) => 
      new Date(b.modified).getTime() - new Date(a.modified).getTime()
    );
    
    res.json({
      success: true,
      count: memoryFiles.length,
      files: memoryFiles
    });
  } catch (error: any) {
    console.error('[Memory] Error listing files:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /memory/recent - Get today's and yesterday's notes
 */
router.get('/recent', async (_req, res) => {
  try {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    const todayFile = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}.md`;
    const yesterdayFile = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}.md`;
    
    const recent: MemoryFile[] = [];
    
    // Try to read today's file
    try {
      const todayPath = path.join(MEMORY_DIR, todayFile);
      const todayContent = await fs.readFile(todayPath, 'utf8');
      const todayStats = await fs.stat(todayPath);
      
      recent.push({
        filename: todayFile,
        path: todayPath,
        size: todayStats.size,
        modified: todayStats.mtime.toISOString(),
        content: todayContent
      });
    } catch (err) {
      // File doesn't exist - that's ok
    }
    
    // Try to read yesterday's file
    try {
      const yesterdayPath = path.join(MEMORY_DIR, yesterdayFile);
      const yesterdayContent = await fs.readFile(yesterdayPath, 'utf8');
      const yesterdayStats = await fs.stat(yesterdayPath);
      
      recent.push({
        filename: yesterdayFile,
        path: yesterdayPath,
        size: yesterdayStats.size,
        modified: yesterdayStats.mtime.toISOString(),
        content: yesterdayContent
      });
    } catch (err) {
      // File doesn't exist - that's ok
    }
    
    res.json({
      success: true,
      files: recent
    });
  } catch (error: any) {
    console.error('[Memory] Error reading recent files:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /memory/heartbeat - Get HEARTBEAT.md content
 * NOTE: Must be BEFORE /:filename route to avoid being caught by wildcard
 */
router.get('/heartbeat', async (_req, res) => {
  try {
    // HEARTBEAT.md is in workspace root, not memory/
    const heartbeatPath = '/workspace/HEARTBEAT.md';
    const content = await fs.readFile(heartbeatPath, 'utf8');
    const stats = await fs.stat(heartbeatPath);
    
    res.json({
      success: true,
      content,
      modified: stats.mtime.toISOString(),
      size: stats.size
    });
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      res.status(404).json({
        success: false,
        error: 'HEARTBEAT.md not found'
      });
    } else {
      console.error('[Memory] Error reading HEARTBEAT:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

/**
 * GET /memory/:filename - Get specific memory file content
 * NOTE: This must be AFTER specific routes like /heartbeat
 */
router.get('/:filename', async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    
    // Security: prevent directory traversal
    if (filename.includes('..') || filename.includes('/')) {
      res.status(400).json({
        success: false,
        error: 'Invalid filename'
      });
      return;
    }
    
    const filePath = path.join(MEMORY_DIR, filename);
    const content = await fs.readFile(filePath, 'utf8');
    const stats = await fs.stat(filePath);
    
    res.json({
      success: true,
      file: {
        filename,
        path: filePath,
        size: stats.size,
        modified: stats.mtime.toISOString(),
        content
      }
    });
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      res.status(404).json({
        success: false,
        error: 'File not found'
      });
    } else {
      console.error('[Memory] Error reading file:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

export default router;
