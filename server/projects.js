import { promises as fs } from 'fs';
import fsSync from 'fs';
import path from 'path';
import readline from 'readline';
import { spawn } from 'child_process';
import backgroundJobManager from './background-jobs.js';

// Cache for extracted project directories
const projectDirectoryCache = new Map();
let cacheTimestamp = Date.now();

// Clear cache when needed (called when project files change)
function clearProjectDirectoryCache() {
  projectDirectoryCache.clear();
  cacheTimestamp = Date.now();
}

// Load project configuration file
async function loadProjectConfig() {
  const configPath = path.join(process.env.HOME, '.claude', 'project-config.json');
  try {
    const configData = await fs.readFile(configPath, 'utf8');
    return JSON.parse(configData);
  } catch (error) {
    // Return empty config if file doesn't exist
    return {};
  }
}

// Save project configuration file
async function saveProjectConfig(config) {
  const configPath = path.join(process.env.HOME, '.claude', 'project-config.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
}

// Generate better display name from path
async function generateDisplayName(projectName, actualProjectDir = null) {
  // Use actual project directory if provided, otherwise decode from project name
  let projectPath = actualProjectDir || projectName.replace(/-/g, '/');
  
  // Try to read package.json from the project path
  try {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const packageData = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageData);
    
    // Return the name from package.json if it exists
    if (packageJson.name) {
      return packageJson.name;
    }
  } catch (error) {
    // Fall back to path-based naming if package.json doesn't exist or can't be read
  }
  
  // If it starts with /, it's an absolute path
  if (projectPath.startsWith('/')) {
    const parts = projectPath.split('/').filter(Boolean);
    if (parts.length > 3) {
      // Show last 2 folders with ellipsis: "...projects/myapp"
      return `.../${parts.slice(-2).join('/')}`;
    } else {
      // Show full path if short: "/home/user"
      return projectPath;
    }
  }
  
  return projectPath;
}

// Extract the actual project directory from JSONL sessions (with caching)
async function extractProjectDirectory(projectName) {
  // Check cache first
  if (projectDirectoryCache.has(projectName)) {
    return projectDirectoryCache.get(projectName);
  }
  
  // Extract project directory from JSONL sessions
  
  const projectDir = path.join(process.env.HOME, '.claude', 'projects', projectName);
  const cwdCounts = new Map();
  let latestTimestamp = 0;
  let latestCwd = null;
  let extractedPath;
  
  try {
    const files = await fs.readdir(projectDir);
    const jsonlFiles = files.filter(file => file.endsWith('.jsonl'));
    
    if (jsonlFiles.length === 0) {
      // Fall back to decoded project name if no sessions
      extractedPath = projectName.replace(/-/g, '/');
    } else {
      // Process all JSONL files to collect cwd values
      for (const file of jsonlFiles) {
        const jsonlFile = path.join(projectDir, file);
        const fileStream = fsSync.createReadStream(jsonlFile);
        const rl = readline.createInterface({
          input: fileStream,
          crlfDelay: Infinity
        });
        
        for await (const line of rl) {
          if (line.trim()) {
            try {
              const entry = JSON.parse(line);
              
              if (entry.cwd) {
                // Count occurrences of each cwd
                cwdCounts.set(entry.cwd, (cwdCounts.get(entry.cwd) || 0) + 1);
                
                // Track the most recent cwd
                const timestamp = new Date(entry.timestamp || 0).getTime();
                if (timestamp > latestTimestamp) {
                  latestTimestamp = timestamp;
                  latestCwd = entry.cwd;
                }
              }
            } catch (parseError) {
              // Skip malformed lines
            }
          }
        }
      }
      
      // Determine the best cwd to use
      if (cwdCounts.size === 0) {
        // No cwd found, fall back to decoded project name
        extractedPath = projectName.replace(/-/g, '/');
      } else if (cwdCounts.size === 1) {
        // Only one cwd, use it
        extractedPath = Array.from(cwdCounts.keys())[0];
      } else {
        // Multiple cwd values - prefer the most recent one if it has reasonable usage
        const mostRecentCount = cwdCounts.get(latestCwd) || 0;
        const maxCount = Math.max(...cwdCounts.values());
        
        // Use most recent if it has at least 25% of the max count
        if (mostRecentCount >= maxCount * 0.25) {
          extractedPath = latestCwd;
        } else {
          // Otherwise use the most frequently used cwd
          for (const [cwd, count] of cwdCounts.entries()) {
            if (count === maxCount) {
              extractedPath = cwd;
              break;
            }
          }
        }
        
        // Fallback (shouldn't reach here)
        if (!extractedPath) {
          extractedPath = latestCwd || projectName.replace(/-/g, '/');
        }
      }
    }
    
    // Cache the result
    projectDirectoryCache.set(projectName, extractedPath);
    
    return extractedPath;
    
  } catch (error) {
    console.error(`Error extracting project directory for ${projectName}:`, error);
    // Fall back to decoded project name
    extractedPath = projectName.replace(/-/g, '/');
    
    // Cache the fallback result too
    projectDirectoryCache.set(projectName, extractedPath);
    
    return extractedPath;
  }
}

async function getProjects() {
  const claudeDir = path.join(process.env.HOME, '.claude', 'projects');
  const config = await loadProjectConfig();
  const projects = [];
  const existingProjects = new Set();
  
  // Get the current working directory projects folder path
  const cwd = process.cwd();
  const localProjectsDir = path.resolve(cwd, 'projects');
  
  // Clean up projects not in ./projects folder in background
  cleanupNonProjectsFolderProjects().catch(() => {
    // Ignore cleanup errors - it's a background task
  });
  
  // First, get list of actual projects that exist in ./projects folder
  let validProjectPaths = new Set();
  try {
    const projectEntries = await fs.readdir(localProjectsDir, { withFileTypes: true });
    for (const entry of projectEntries) {
      if (entry.isDirectory()) {
        const fullPath = path.join(localProjectsDir, entry.name);
        validProjectPaths.add(path.resolve(fullPath));
      }
    }
  } catch (error) {
    // No ./projects folder found - this is expected on first run
  }
  
  try {
    // Get existing Claude projects from the file system
    const entries = await fs.readdir(claudeDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        existingProjects.add(entry.name);
        
        // Extract actual project directory from JSONL sessions
        const actualProjectDir = await extractProjectDirectory(entry.name);
        const normalizedActualDir = path.resolve(actualProjectDir);
        
        // Only include projects that exist in our ./projects folder
        if (!validProjectPaths.has(normalizedActualDir)) {
          // Skip without logging - filtering is working as expected
          continue;
        }
        
        // Get display name from config or generate one
        const customName = config[entry.name]?.displayName;
        const autoDisplayName = await generateDisplayName(entry.name, actualProjectDir);
        
        // Remove any existing prefixes for clean display
        let displayName = customName || autoDisplayName;
        if (displayName.startsWith('projects/')) {
          displayName = displayName.replace('projects/', '');
        }
        if (displayName.startsWith('.../projects/')) {
          displayName = displayName.replace('.../projects/', '');
        }
        // Keep just the clean project name
        
        const project = {
          name: entry.name,
          path: actualProjectDir,
          displayName: displayName,
          fullPath: actualProjectDir,
          isCustomName: !!customName,
          sessions: []
        };
        
        // Try to get sessions for this project (just first 5 for performance)
        try {
          const sessionResult = await getSessions(entry.name, 5, 0);
          project.sessions = sessionResult.sessions || [];
          project.sessionMeta = {
            hasMore: sessionResult.hasMore,
            total: sessionResult.total
          };
        } catch (e) {
          console.warn(`Could not load sessions for project ${entry.name}:`, e.message);
        }
        
        projects.push(project);
      }
    }
  } catch (error) {
    console.error('Error reading projects directory:', error);
  }
  
  // Add manually configured projects that don't exist as folders yet
  for (const [projectName, projectConfig] of Object.entries(config)) {
    if (!existingProjects.has(projectName) && projectConfig.manuallyAdded) {
      // Use the original path if available, otherwise extract from potential sessions
      let actualProjectDir = projectConfig.originalPath;
      
      if (!actualProjectDir) {
        try {
          actualProjectDir = await extractProjectDirectory(projectName);
        } catch (error) {
          // Fall back to decoded project name
          actualProjectDir = projectName.replace(/-/g, '/');
        }
      }
      
      // Only include manually configured projects that exist in our ./projects folder
      if (!actualProjectDir) {
        // Skip projects without valid directory
        continue;
      }
      
      const normalizedActualDir = path.resolve(actualProjectDir);
      if (!validProjectPaths.has(normalizedActualDir)) {
        // Skip without logging - filtering is working as expected
        continue;
      }
      
      // Get display name and remove any existing prefixes for clean display
      const autoDisplayName = await generateDisplayName(projectName, actualProjectDir);
      let displayName = projectConfig.displayName || autoDisplayName;
      if (displayName.startsWith('projects/')) {
        displayName = displayName.replace('projects/', '');
      }
      if (displayName.startsWith('.../projects/')) {
        displayName = displayName.replace('.../projects/', '');
      }
      // Keep just the clean project name
      
      const project = {
        name: projectName,
        path: actualProjectDir,
        displayName: displayName,
        fullPath: actualProjectDir,
        isCustomName: !!projectConfig.displayName,
        isManuallyAdded: true,
        sessions: []
      };
      
      projects.push(project);
    }
  }
  
  return projects;
}

async function getSessions(projectName, limit = 5, offset = 0) {
  const projectDir = path.join(process.env.HOME, '.claude', 'projects', projectName);
  
  try {
    const files = await fs.readdir(projectDir);
    const jsonlFiles = files.filter(file => file.endsWith('.jsonl'));
    
    if (jsonlFiles.length === 0) {
      return { sessions: [], hasMore: false, total: 0 };
    }
    
    // For performance, get file stats to sort by modification time
    const filesWithStats = await Promise.all(
      jsonlFiles.map(async (file) => {
        const filePath = path.join(projectDir, file);
        const stats = await fs.stat(filePath);
        return { file, mtime: stats.mtime };
      })
    );
    
    // Sort files by modification time (newest first) for better performance
    filesWithStats.sort((a, b) => b.mtime - a.mtime);
    
    const allSessions = new Map();
    let processedCount = 0;
    
    // Process files in order of modification time
    for (const { file } of filesWithStats) {
      const jsonlFile = path.join(projectDir, file);
      const sessions = await parseJsonlSessions(jsonlFile);
      
      // Merge sessions, avoiding duplicates by session ID
      sessions.forEach(session => {
        if (!allSessions.has(session.id)) {
          allSessions.set(session.id, session);
        }
      });
      
      processedCount++;
      
      // Early exit optimization: if we have enough sessions and processed recent files
      if (allSessions.size >= (limit + offset) * 2 && processedCount >= Math.min(3, filesWithStats.length)) {
        break;
      }
    }
    
    // Convert to array and sort by last activity
    const sortedSessions = Array.from(allSessions.values()).sort((a, b) => 
      new Date(b.lastActivity) - new Date(a.lastActivity)
    );
    
    const total = sortedSessions.length;
    const paginatedSessions = sortedSessions.slice(offset, offset + limit);
    const hasMore = offset + limit < total;
    
    return {
      sessions: paginatedSessions,
      hasMore,
      total,
      offset,
      limit
    };
  } catch (error) {
    console.error(`Error reading sessions for project ${projectName}:`, error);
    return { sessions: [], hasMore: false, total: 0 };
  }
}

async function parseJsonlSessions(filePath) {
  const sessions = new Map();
  
  try {
    const fileStream = fsSync.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    
    // console.log(`[JSONL Parser] Reading file: ${filePath}`);
    let lineCount = 0;
    
    for await (const line of rl) {
      if (line.trim()) {
        lineCount++;
        try {
          const entry = JSON.parse(line);
          
          if (entry.sessionId) {
            if (!sessions.has(entry.sessionId)) {
              sessions.set(entry.sessionId, {
                id: entry.sessionId,
                summary: 'New Session',
                messageCount: 0,
                lastActivity: new Date(),
                cwd: entry.cwd || ''
              });
            }
            
            const session = sessions.get(entry.sessionId);
            
            // Update summary if this is a summary entry
            if (entry.type === 'summary' && entry.summary) {
              session.summary = entry.summary;
            } else if (entry.message?.role === 'user' && entry.message?.content && session.summary === 'New Session') {
              // Use first user message as summary if no summary entry exists
              const content = entry.message.content;
              if (typeof content === 'string' && content.length > 0) {
                // Skip command messages that start with <command-name>
                if (!content.startsWith('<command-name>')) {
                  session.summary = content.length > 50 ? content.substring(0, 50) + '...' : content;
                }
              }
            }
            
            // Count messages instead of storing them all
            session.messageCount = (session.messageCount || 0) + 1;
            
            // Update last activity
            if (entry.timestamp) {
              session.lastActivity = new Date(entry.timestamp);
            }
          }
        } catch (parseError) {
          console.warn(`[JSONL Parser] Error parsing line ${lineCount}:`, parseError.message);
        }
      }
    }
    
    // console.log(`[JSONL Parser] Processed ${lineCount} lines, found ${sessions.size} sessions`);
  } catch (error) {
    console.error('Error reading JSONL file:', error);
  }
  
  // Convert Map to Array and sort by last activity
  return Array.from(sessions.values()).sort((a, b) => 
    new Date(b.lastActivity) - new Date(a.lastActivity)
  );
}

// Get messages for a specific session
async function getSessionMessages(projectName, sessionId) {
  const projectDir = path.join(process.env.HOME, '.claude', 'projects', projectName);
  
  try {
    const files = await fs.readdir(projectDir);
    const jsonlFiles = files.filter(file => file.endsWith('.jsonl'));
    
    if (jsonlFiles.length === 0) {
      return [];
    }
    
    const messages = [];
    
    // Process all JSONL files to find messages for this session
    for (const file of jsonlFiles) {
      const jsonlFile = path.join(projectDir, file);
      const fileStream = fsSync.createReadStream(jsonlFile);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });
      
      for await (const line of rl) {
        if (line.trim()) {
          try {
            const entry = JSON.parse(line);
            if (entry.sessionId === sessionId) {
              messages.push(entry);
            }
          } catch (parseError) {
            console.warn('Error parsing line:', parseError.message);
          }
        }
      }
    }
    
    // Sort messages by timestamp
    return messages.sort((a, b) => 
      new Date(a.timestamp || 0) - new Date(b.timestamp || 0)
    );
  } catch (error) {
    console.error(`Error reading messages for session ${sessionId}:`, error);
    return [];
  }
}

// Rename a project's display name
async function renameProject(projectName, newDisplayName) {
  const config = await loadProjectConfig();
  
  if (!newDisplayName || newDisplayName.trim() === '') {
    // Remove custom name if empty, will fall back to auto-generated
    delete config[projectName];
  } else {
    // Set custom display name
    config[projectName] = {
      displayName: newDisplayName.trim()
    };
  }
  
  await saveProjectConfig(config);
  return true;
}

// Delete a session from a project
async function deleteSession(projectName, sessionId) {
  const projectDir = path.join(process.env.HOME, '.claude', 'projects', projectName);
  
  try {
    const files = await fs.readdir(projectDir);
    const jsonlFiles = files.filter(file => file.endsWith('.jsonl'));
    
    if (jsonlFiles.length === 0) {
      throw new Error('No session files found for this project');
    }
    
    // Check all JSONL files to find which one contains the session
    for (const file of jsonlFiles) {
      const jsonlFile = path.join(projectDir, file);
      const content = await fs.readFile(jsonlFile, 'utf8');
      const lines = content.split('\n').filter(line => line.trim());
      
      // Check if this file contains the session
      const hasSession = lines.some(line => {
        try {
          const data = JSON.parse(line);
          return data.sessionId === sessionId;
        } catch {
          return false;
        }
      });
      
      if (hasSession) {
        // Filter out all entries for this session
        const filteredLines = lines.filter(line => {
          try {
            const data = JSON.parse(line);
            return data.sessionId !== sessionId;
          } catch {
            return true; // Keep malformed lines
          }
        });
        
        // Write back the filtered content
        await fs.writeFile(jsonlFile, filteredLines.join('\n') + (filteredLines.length > 0 ? '\n' : ''));
        return true;
      }
    }
    
    throw new Error(`Session ${sessionId} not found in any files`);
  } catch (error) {
    console.error(`Error deleting session ${sessionId} from project ${projectName}:`, error);
    throw error;
  }
}

// Check if a project is empty (has no sessions)
async function isProjectEmpty(projectName) {
  try {
    const sessionsResult = await getSessions(projectName, 1, 0);
    return sessionsResult.total === 0;
  } catch (error) {
    console.error(`Error checking if project ${projectName} is empty:`, error);
    return false;
  }
}

// Delete an empty project
async function deleteProject(projectName) {
  const projectDir = path.join(process.env.HOME, '.claude', 'projects', projectName);
  
  try {
    // First check if the project is empty
    const isEmpty = await isProjectEmpty(projectName);
    if (!isEmpty) {
      throw new Error('Cannot delete project with existing sessions');
    }
    
    // Remove the project directory
    await fs.rm(projectDir, { recursive: true, force: true });
    
    // Remove from project config
    const config = await loadProjectConfig();
    delete config[projectName];
    await saveProjectConfig(config);
    
    return true;
  } catch (error) {
    console.error(`Error deleting project ${projectName}:`, error);
    throw error;
  }
}

// Clone a git repository to a specified directory (legacy synchronous version)
async function cloneRepository(repositoryUrl, targetPath) {
  return new Promise((resolve, reject) => {
    // Validate repository URL
    const gitUrlPattern = /^(https?:\/\/|git@|ssh:\/\/)/i;
    if (!gitUrlPattern.test(repositoryUrl)) {
      reject(new Error('Invalid repository URL. Must be a valid git URL (https, ssh, or git protocol).'));
      return;
    }

    console.log(`Starting git clone of ${repositoryUrl} to ${targetPath}`);
    
    const gitProcess = spawn('git', ['clone', repositoryUrl, '.'], {
      cwd: targetPath,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    gitProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    gitProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    gitProcess.on('close', (code) => {
      if (code === 0) {
        console.log(`Git clone completed successfully: ${stdout}`);
        resolve(stdout);
      } else {
        const errorMessage = stderr || stdout || `Git clone failed with exit code ${code}`;
        console.error(`Git clone failed: ${errorMessage}`);
        reject(new Error(errorMessage));
      }
    });

    gitProcess.on('error', (error) => {
      console.error(`Git clone process error: ${error.message}`);
      reject(new Error(`Failed to start git clone: ${error.message}`));
    });

    // Set a timeout for the clone operation (5 minutes)
    setTimeout(() => {
      gitProcess.kill();
      reject(new Error('Git clone operation timed out after 5 minutes'));
    }, 5 * 60 * 1000);
  });
}

// Start background clone job
function startBackgroundClone(repositoryUrl, targetPath, displayName, onProgress) {
  return backgroundJobManager.startCloneJob(repositoryUrl, targetPath, displayName, onProgress);
}

// Complete project setup after successful background clone
async function completeProjectSetup(absolutePath, displayName) {
  // Generate project name (encode path for use as directory name)
  const projectName = absolutePath.replace(/\//g, '-');
  
  // Check if project already exists in config or as a folder
  const config = await loadProjectConfig();
  const projectDir = path.join(process.env.HOME, '.claude', 'projects', projectName);
  
  try {
    await fs.access(projectDir);
    console.warn(`Project directory already exists for path: ${absolutePath}`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Create project directory
      await fs.mkdir(projectDir, { recursive: true });
    }
  }
  
  // Add to config as manually added project
  config[projectName] = {
    manuallyAdded: true,
    originalPath: absolutePath
  };
  
  if (displayName) {
    config[projectName].displayName = displayName;
  }
  
  await saveProjectConfig(config);
  
  // Create project folder structure
  try {
    await fs.mkdir(projectDir, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw new Error(`Failed to create project directory: ${error.message}`);
    }
  }
  
  return {
    name: projectName,
    path: absolutePath,
    displayName: displayName || path.basename(absolutePath),
    status: 'ready'
  };
}

// Get background job status
function getCloneJobStatus(jobId) {
  return backgroundJobManager.getJob(jobId);
}

// Get all clone jobs
function getAllCloneJobs() {
  return backgroundJobManager.getJobsByType('clone');
}

// Clean up Claude projects that are not in ./projects folder
async function cleanupNonProjectsFolderProjects() {
  const claudeDir = path.join(process.env.HOME, '.claude', 'projects');
  const cwd = process.cwd();
  const localProjectsDir = path.resolve(cwd, 'projects');
  
  // Get list of actual projects that exist in ./projects folder
  let validProjectPaths = new Set();
  try {
    const projectEntries = await fs.readdir(localProjectsDir, { withFileTypes: true });
    for (const entry of projectEntries) {
      if (entry.isDirectory()) {
        const fullPath = path.join(localProjectsDir, entry.name);
        validProjectPaths.add(path.resolve(fullPath));
      }
    }
  } catch (error) {
    console.log('No ./projects folder found:', error.message);
    return { removed: [], errors: [] };
  }
  
  const removed = [];
  const errors = [];
  
  try {
    const entries = await fs.readdir(claudeDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Extract actual project directory from JSONL sessions
        const actualProjectDir = await extractProjectDirectory(entry.name);
        const normalizedActualDir = path.resolve(actualProjectDir);
        
        // If project is not in ./projects folder, remove it
        if (!validProjectPaths.has(normalizedActualDir)) {
          try {
            const projectPath = path.join(claudeDir, entry.name);
            await fs.rm(projectPath, { recursive: true, force: true });
            removed.push({ name: entry.name, path: actualProjectDir });
            // Removed successfully
          } catch (error) {
            errors.push({ name: entry.name, path: actualProjectDir, error: error.message });
          }
        }
      }
    }
  } catch (error) {
    errors.push({ error: error.message });
  }
  
  return { removed, errors };
}

// Add a project manually to the config (creates folders if they don't exist)
async function addProjectManually(projectPath, displayName = null, repositoryUrl = null, backgroundClone = false, onProgress = null) {
  // Resolve paths properly based on their nature
  let absolutePath;
  
  // Always create projects in ./projects folder for consistent organization
  const cwd = process.cwd();
  const projectsDir = path.resolve(cwd, 'projects');
  
  if (path.isAbsolute(projectPath)) {
    // For absolute paths, extract just the project name and put it in ./projects
    const projectName = path.basename(projectPath);
    absolutePath = path.resolve(projectsDir, projectName);
    console.log(`Converting absolute path '${projectPath}' to projects folder: ${absolutePath}`);
  } else {
    // For relative paths, extract project name and put it in ./projects
    const projectName = path.basename(projectPath);
    absolutePath = path.resolve(projectsDir, projectName);
    console.log(`Creating project '${projectName}' in projects folder: ${absolutePath}`);
  }
  
  try {
    // Check if the path exists
    await fs.access(absolutePath);
    
    // If directory exists and repository URL is provided, check if it's empty
    if (repositoryUrl) {
      const files = await fs.readdir(absolutePath);
      if (files.length > 0) {
        throw new Error(`Directory ${absolutePath} is not empty. Cannot clone repository into existing directory with files.`);
      }
    }
  } catch (error) {
    // If path doesn't exist, create it
    if (error.code === 'ENOENT') {
      try {
        await fs.mkdir(absolutePath, { recursive: true });
        console.log(`Created directory: ${absolutePath}`);
      } catch (mkdirError) {
        throw new Error(`Failed to create directory ${absolutePath}: ${mkdirError.message}`);
      }
    } else {
      throw error;
    }
  }
  
  // If repository URL is provided, clone the repository
  if (repositoryUrl) {
    // Auto-generate display name from repository URL if not provided
    if (!displayName) {
      const repoName = repositoryUrl.split('/').pop().replace(/\.git$/, '');
      displayName = repoName;
    }

    if (backgroundClone) {
      // Start background clone and return immediately
      console.log(`Starting background clone of ${repositoryUrl} to ${absolutePath}`);
      const jobId = startBackgroundClone(repositoryUrl, absolutePath, displayName, onProgress);
      
      // Return project info with clone job ID
      const projectName = absolutePath.replace(/\//g, '-');
      return {
        name: projectName,
        path: absolutePath,
        displayName,
        status: 'cloning',
        cloneJobId: jobId
      };
    } else {
      // Synchronous clone (legacy behavior)
      try {
        console.log(`Cloning repository ${repositoryUrl} to ${absolutePath}`);
        await cloneRepository(repositoryUrl, absolutePath);
        console.log(`Successfully cloned repository to ${absolutePath}`);
      } catch (cloneError) {
        // Clean up the directory if clone fails
        try {
          await fs.rmdir(absolutePath, { recursive: true });
        } catch (cleanupError) {
          console.warn(`Failed to clean up directory after clone failure: ${cleanupError.message}`);
        }
        throw new Error(`Failed to clone repository: ${cloneError.message}`);
      }
    }
  }
  
  // Generate project name (encode path for use as directory name)
  const projectName = absolutePath.replace(/\//g, '-');
  
  // Check if project already exists in config or as a folder
  const config = await loadProjectConfig();
  const projectDir = path.join(process.env.HOME, '.claude', 'projects', projectName);
  
  try {
    await fs.access(projectDir);
    throw new Error(`Project already exists for path: ${absolutePath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  
  if (config[projectName]) {
    throw new Error(`Project already configured for path: ${absolutePath}`);
  }
  
  // Add to config as manually added project
  config[projectName] = {
    manuallyAdded: true,
    originalPath: absolutePath
  };
  
  if (displayName) {
    config[projectName].displayName = displayName;
  }
  
  await saveProjectConfig(config);
  
  
  return {
    name: projectName,
    path: absolutePath,
    fullPath: absolutePath,
    displayName: displayName || await generateDisplayName(projectName, absolutePath),
    isManuallyAdded: true,
    sessions: []
  };
}


export {
  getProjects,
  getSessions,
  getSessionMessages,
  parseJsonlSessions,
  renameProject,
  deleteSession,
  isProjectEmpty,
  deleteProject,
  addProjectManually,
  loadProjectConfig,
  saveProjectConfig,
  extractProjectDirectory,
  clearProjectDirectoryCache,
  cleanupNonProjectsFolderProjects,
  startBackgroundClone,
  completeProjectSetup,
  getCloneJobStatus,
  getAllCloneJobs
};