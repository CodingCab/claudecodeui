import { spawn } from 'child_process';
import path from 'path';
import { promises as fs } from 'fs';

class BackgroundJobManager {
  constructor() {
    this.jobs = new Map();
    this.jobCounter = 0;
  }

  createJob(type, data) {
    const jobId = `${type}-${++this.jobCounter}-${Date.now()}`;
    const job = {
      id: jobId,
      type,
      status: 'pending',
      progress: 0,
      data,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      error: null,
      result: null
    };
    
    this.jobs.set(jobId, job);
    return jobId;
  }

  getJob(jobId) {
    return this.jobs.get(jobId);
  }

  updateJob(jobId, updates) {
    const job = this.jobs.get(jobId);
    if (job) {
      Object.assign(job, updates);
      return job;
    }
    return null;
  }

  deleteJob(jobId) {
    return this.jobs.delete(jobId);
  }

  getAllJobs() {
    return Array.from(this.jobs.values());
  }

  getJobsByType(type) {
    return Array.from(this.jobs.values()).filter(job => job.type === type);
  }

  // Clone repository with progress tracking
  async startCloneJob(repositoryUrl, targetPath, displayName, onProgress) {
    const jobId = this.createJob('clone', {
      repositoryUrl,
      targetPath,
      displayName
    });

    // Start the clone process asynchronously
    this.executeCloneJob(jobId, repositoryUrl, targetPath, onProgress).catch(error => {
      this.updateJob(jobId, {
        status: 'failed',
        error: error.message,
        completedAt: new Date().toISOString()
      });
      if (onProgress) {
        onProgress(jobId, { status: 'failed', error: error.message });
      }
    });

    return jobId;
  }

  async executeCloneJob(jobId, repositoryUrl, targetPath, onProgress) {
    const job = this.updateJob(jobId, {
      status: 'running',
      startedAt: new Date().toISOString()
    });

    if (onProgress) {
      onProgress(jobId, { status: 'running', progress: 0 });
    }

    return new Promise((resolve, reject) => {
      // Validate repository URL
      const gitUrlPattern = /^(https?:\/\/|git@|ssh:\/\/)/i;
      if (!gitUrlPattern.test(repositoryUrl)) {
        const error = new Error('Invalid repository URL. Must be a valid git URL (https, ssh, or git protocol).');
        this.updateJob(jobId, {
          status: 'failed',
          error: error.message,
          completedAt: new Date().toISOString()
        });
        return reject(error);
      }

      console.log(`[Job ${jobId}] Starting git clone of ${repositoryUrl} to ${targetPath}`);
      
      const gitProcess = spawn('git', ['clone', '--progress', repositoryUrl, '.'], {
        cwd: targetPath,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      let lastProgress = 0;

      gitProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      gitProcess.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        
        // Parse git clone progress from stderr (git outputs progress to stderr)
        const progressMatch = chunk.match(/(\d+)%/);
        if (progressMatch) {
          const progress = parseInt(progressMatch[1]);
          if (progress > lastProgress) {
            lastProgress = progress;
            this.updateJob(jobId, { progress });
            if (onProgress) {
              onProgress(jobId, { status: 'running', progress });
            }
          }
        }
        
        // Also check for "Receiving objects" pattern
        const receivingMatch = chunk.match(/Receiving objects:\s*(\d+)%/);
        if (receivingMatch) {
          const progress = Math.min(parseInt(receivingMatch[1]), 90); // Cap at 90% for receiving
          if (progress > lastProgress) {
            lastProgress = progress;
            this.updateJob(jobId, { progress });
            if (onProgress) {
              onProgress(jobId, { status: 'running', progress });
            }
          }
        }

        // Check for "Resolving deltas" pattern (final stage)
        if (chunk.includes('Resolving deltas')) {
          const progress = 95;
          if (progress > lastProgress) {
            lastProgress = progress;
            this.updateJob(jobId, { progress });
            if (onProgress) {
              onProgress(jobId, { status: 'running', progress });
            }
          }
        }
      });

      gitProcess.on('close', (code) => {
        if (code === 0) {
          console.log(`[Job ${jobId}] Git clone completed successfully`);
          const result = { stdout, stderr };
          this.updateJob(jobId, {
            status: 'completed',
            progress: 100,
            result,
            completedAt: new Date().toISOString()
          });
          if (onProgress) {
            onProgress(jobId, { status: 'completed', progress: 100, result });
          }
          resolve(result);
        } else {
          const errorMessage = stderr || stdout || `Git clone failed with exit code ${code}`;
          console.error(`[Job ${jobId}] Git clone failed: ${errorMessage}`);
          const error = new Error(errorMessage);
          this.updateJob(jobId, {
            status: 'failed',
            error: errorMessage,
            completedAt: new Date().toISOString()
          });
          if (onProgress) {
            onProgress(jobId, { status: 'failed', error: errorMessage });
          }
          reject(error);
        }
      });

      gitProcess.on('error', (error) => {
        console.error(`[Job ${jobId}] Git clone process error: ${error.message}`);
        const errorMessage = `Failed to start git clone: ${error.message}`;
        this.updateJob(jobId, {
          status: 'failed',
          error: errorMessage,
          completedAt: new Date().toISOString()
        });
        if (onProgress) {
          onProgress(jobId, { status: 'failed', error: errorMessage });
        }
        reject(new Error(errorMessage));
      });

      // Set a timeout for the clone operation (10 minutes)
      setTimeout(() => {
        if (gitProcess.pid) {
          gitProcess.kill();
          const errorMessage = 'Git clone operation timed out after 10 minutes';
          this.updateJob(jobId, {
            status: 'failed',
            error: errorMessage,
            completedAt: new Date().toISOString()
          });
          if (onProgress) {
            onProgress(jobId, { status: 'failed', error: errorMessage });
          }
          reject(new Error(errorMessage));
        }
      }, 10 * 60 * 1000);
    });
  }

  // Clean up completed jobs older than 1 hour
  cleanupOldJobs() {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    for (const [jobId, job] of this.jobs.entries()) {
      if (job.status === 'completed' || job.status === 'failed') {
        const completedAt = new Date(job.completedAt);
        if (completedAt < oneHourAgo) {
          this.jobs.delete(jobId);
        }
      }
    }
  }
}

// Singleton instance
const backgroundJobManager = new BackgroundJobManager();

// Clean up old jobs every 30 minutes
setInterval(() => {
  backgroundJobManager.cleanupOldJobs();
}, 30 * 60 * 1000);

export default backgroundJobManager;