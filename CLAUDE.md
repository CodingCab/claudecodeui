# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Code UI is a web-based interface for the Claude Code CLI tool. It provides a responsive desktop and mobile UI for managing Claude Code projects, sessions, and real-time chat interactions. The application enables users to browse files, manage git operations, and interact with Claude through both chat interface and integrated terminal.

## Development Commands

### Core Development Workflow
```bash
# Install dependencies
npm install

# Start development server (concurrently runs both frontend and backend)
npm run dev

# Frontend only (Vite dev server on port 3001)
npm run client

# Backend only (Express server on port 3002)
npm run server

# Production build
npm run build

# Production mode (build + start server)
npm start

# Preview production build
npm preview
```

### Environment Setup
- Copy `.env.example` to `.env` and configure settings
- Requires Node.js v20+ and Claude Code CLI installed
- Backend runs on port 3002, frontend dev server on port 3001
- Production serves static files from backend

## Architecture Overview

### Technology Stack
- **Frontend**: React 18 + Vite + Tailwind CSS + CodeMirror
- **Backend**: Express.js + WebSocket + SQLite (better-sqlite3)
- **Authentication**: JWT tokens with bcrypt password hashing
- **Real-time**: WebSocket for chat communication and project updates
- **Terminal**: node-pty for shell integration with Claude CLI

### Core Architecture
```
Frontend (React/Vite) ←→ Backend (Express/WS) ←→ Claude CLI Integration
    ↓                        ↓                      ↓
Chat Interface           WebSocket Server      Process Spawning
File Explorer           RESTful API           Session Management
Git Panel               Authentication        File System Watcher
Mobile UI               SQLite Database       Shell Terminal
```

### Key Components

**Frontend Structure**:
- `src/App.jsx` - Main application with session protection system and routing
- `src/components/` - UI components including ChatInterface, FileTree, GitPanel
- `src/contexts/` - AuthContext and ThemeContext for state management
- `src/utils/` - API client, WebSocket connection, and audio transcription utilities

**Backend Structure**:
- `server/index.js` - Main Express server with WebSocket handling
- `server/claude-cli.js` - Claude CLI process management and communication
- `server/projects.js` - Project discovery and session management
- `server/routes/` - Authentication and Git API routes
- `server/database/` - SQLite database setup and authentication

### Session Protection System
The app implements a sophisticated session protection system in `src/App.jsx` that prevents automatic project updates from interrupting active conversations:
- Tracks active sessions during chat interactions
- Pauses project updates when user is actively chatting
- Allows additive updates (new sessions/projects) while protecting active chats
- Handles both real session IDs and temporary session identifiers

### WebSocket Communication
Two WebSocket endpoints handle different functionalities:
- `/ws` - Chat messages and project updates
- `/shell` - Terminal/shell integration with Claude CLI

### Authentication Flow
- JWT-based authentication with user registration/login
- Tokens stored in localStorage and validated on each request
- WebSocket connections authenticated via query parameters
- Protected routes require valid JWT tokens

## File System Integration

### Project Discovery
- Automatically scans `~/.claude/projects/` for Claude projects
- Uses chokidar for real-time file system watching
- Caches project directories to improve performance

### File Operations
- Read/write file content through `/api/projects/:projectName/file`
- File tree browsing with `/api/projects/:projectName/files`
- Binary file serving for images and other assets
- Backup creation before file modifications

## Development Patterns

### State Management
- React Context for authentication and theme
- Component-level state with hooks
- WebSocket messages for real-time updates
- Local storage for user preferences

### Mobile-First Design
- Responsive UI works on desktop, tablet, and mobile
- Bottom navigation for mobile devices
- Touch-friendly interactions and swipe gestures
- PWA support with manifest.json

### Error Handling
- Comprehensive error boundaries and try-catch blocks
- Graceful degradation for failed operations
- User-friendly error messages and fallbacks

## Configuration

### Environment Variables
- `PORT` - Backend server port (default: 3000)
- `VITE_PORT` - Frontend dev server port (default: 3001)
- `OPENAI_API_KEY` - For audio transcription features
- Authentication and database settings in `.env`

### Build Configuration
- Vite handles frontend bundling and hot reload
- Tailwind CSS for styling with custom configuration
- PostCSS for CSS processing
- Static assets served from `public/` directory

## Testing and Quality

### File Structure Conventions
- Components in `src/components/` with JSX extension
- Utilities in `src/utils/` for API and helper functions
- Server routes organized in `server/routes/`
- Database operations in `server/database/`

### Development Best Practices
- ES6 modules throughout the codebase
- Async/await for asynchronous operations
- Proper error handling with try-catch blocks
- WebSocket connection management with reconnection logic
- Secure file operations with path validation