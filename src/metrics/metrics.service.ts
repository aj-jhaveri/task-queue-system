import client from 'prom-client';

export class MetricsService {
  public register: client.Registry;
  public jobsProcessedTotal: client.Counter<'job_type' | 'status'>;
  public jobsFailedTotal: client.Counter<'job_type' | 'error_type'>;
  public processingDuration: client.Histogram<'job_type'>;
  public queueDepthGauge: client.Gauge<'queue_name' | 'state'>;
  public dashboardSnapshotTotal: client.Counter<'source'>;

  constructor() {
    this.register = new client.Registry();
    client.collectDefaultMetrics({ register: this.register });

    // status="success" folds in idempotent duplicates: a job short-circuited by
    // the SQLite replay cache never ran its side-effect but still completes.
    // That is countable separately via the isDuplicate field on the job result;
    // it is called out here so a reader of the dashboard does not read this
    // counter as "work performed".
    this.jobsProcessedTotal = new client.Counter({
      name: 'task_queue_jobs_processed_total',
      help:
        'Jobs processed. status="success" INCLUDES idempotent duplicates that were ' +
        'short-circuited before their side-effect ran, so this is not a count of ' +
        'work performed.',
      labelNames: ['job_type', 'status'],
      registers: [this.register],
    });

    // Incremented from the worker's `failed` event, which fires once per
    // ATTEMPT. A single job retried to exhaustion increments this three times
    // by default. Terminal failures are countable from the DLQ, not from here -
    // reading this as a job count overstates failures by up to the retry limit.
    this.jobsFailedTotal = new client.Counter({
      name: 'task_queue_jobs_failed_total',
      help:
        'Failed job ATTEMPTS, not failed jobs. A job retried to exhaustion increments ' +
        'this once per attempt (3 by default). Count terminal failures from the DLQ.',
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

    // Divide source="redis" by source="cache" to see how much Redis budget the
    // public dashboard is actually consuming. A healthy ratio is heavily skewed
    // toward "cache"; a rising "redis" count means snapshots are being invalidated
    // more often than expected and is the first place to look if the Upstash
    // command counter climbs faster than the projection in docs/design_decisions.md.
    this.dashboardSnapshotTotal = new client.Counter({
      name: 'task_queue_dashboard_snapshot_total',
      // source: `cache` served from a fresh snapshot, `redis` rebuilt against Redis,
      // `stale` served an expired snapshot because the global refresh budget was
      // exhausted, `shed` refused with a 503 because no snapshot existed to serve.
      // A rising `stale`/`shed` count means the dashboard is being hammered.
      help: 'Public dashboard data requests, by whether they hit Redis, the snapshot cache, or the refresh budget',
      labelNames: ['source'],
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
