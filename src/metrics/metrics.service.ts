import client from 'prom-client';

export class MetricsService {
  public register: client.Registry;
  public jobsProcessedTotal: client.Counter<'job_type' | 'status'>;
  public jobsFailedTotal: client.Counter<'job_type' | 'error_type'>;
  public processingDuration: client.Histogram<'job_type'>;
  public queueDepthGauge: client.Gauge<'queue_name' | 'state'>;

  constructor() {
    this.register = new client.Registry();
    client.collectDefaultMetrics({ register: this.register });

    this.jobsProcessedTotal = new client.Counter({
      name: 'task_queue_jobs_processed_total',
      help: 'Total number of task queue jobs processed',
      labelNames: ['job_type', 'status'],
      registers: [this.register],
    });

    this.jobsFailedTotal = new client.Counter({
      name: 'task_queue_jobs_failed_total',
      help: 'Total number of failed task queue jobs',
      labelNames: ['job_type', 'error_type'],
      registers: [this.register],
    });

    this.processingDuration = new client.Histogram({
      name: 'task_queue_processing_duration_seconds',
      help: 'Task processing duration in seconds',
      labelNames: ['job_type'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [this.register],
    });

    this.queueDepthGauge = new client.Gauge({
      name: 'task_queue_depth_jobs',
      help: 'Current queue depth by state',
      labelNames: ['queue_name', 'state'],
      registers: [this.register],
    });
  }

  public getMetricsContentType(): string {
    return this.register.contentType;
  }

  public async getMetrics(): Promise<string> {
    return this.register.metrics();
  }
}

export const metricsService = new MetricsService();
