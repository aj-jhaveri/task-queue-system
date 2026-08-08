import readline from 'readline';
import http from 'http';

const API_BASE = 'http://localhost:3000';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function printBanner(): void {
  console.clear();
  console.log(`
===============================================================
    ⚡ Task Queue System - Interactive CLI Tester
===============================================================
Server: ${API_BASE}
Grafana Dashboard: http://localhost:3001
Bull Board UI:     http://localhost:3000/admin/queues
===============================================================
`);
}

function promptMenu(): void {
  console.log(`
Select an action to execute:

  [1] Send Successful Email Job
  [2] Run Automated Idempotency Test (Send 1st Run + 2nd Duplicate)
  [3] Send Financial Report Job
  [4] Send Failure Simulation Job (Test Retries & DLQ)
  [5] Check System Health (/health)
  [6] View Metrics Summary (/metrics)
  [7] Exit CLI
`);
  rl.question('Enter choice [1-7]: ', handleChoice);
}

function postPromise(path: string, body: object): Promise<{ statusCode: number; data: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(path, API_BASE);

    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let bodyText = '';
        res.on('data', (chunk) => (bodyText += chunk));
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode || 200, data: JSON.parse(bodyText) });
          } catch {
            resolve({ statusCode: res.statusCode || 200, data: bodyText });
          }
        });
      }
    );

    req.on('error', (err) => reject(err));
    req.write(payload);
    req.end();
  });
}

function makeGetRequest(path: string, callback: () => void): void {
  const url = new URL(path, API_BASE);

  http.get(url, (res) => {
    let responseBody = '';
    res.on('data', (chunk) => (responseBody += chunk));
    res.on('end', () => {
      console.log(`\nHTTP Response Status: ${res.statusCode}`);
      try {
        console.log('Response:', JSON.stringify(JSON.parse(responseBody), null, 2));
      } catch {
        console.log('Response Output (truncated):\n', responseBody.substring(0, 500) + '...');
      }
      console.log('\nPress ENTER to continue...');
      rl.question('', () => {
        printBanner();
        promptMenu();
      });
    });
  }).on('error', (err) => {
    console.error('\nHTTP Request Failed:', err.message);
    console.log('Ensure server is running via `npm run dev`!');
    console.log('\nPress ENTER to continue...');
    rl.question('', () => {
      printBanner();
      promptMenu();
    });
  });
}

async function handleChoice(choice: string): Promise<void> {
  const timestamp = Date.now();

  switch (choice.trim()) {
    case '1':
      console.log('\nSending Email Job...');
      try {
        const res = await postPromise('/api/jobs/email', {
          to: 'alex@company.com',
          subject: 'Interactive CLI Welcome',
          body: 'Testing email dispatch from interactive CLI.',
          idempotencyKey: `cli_email_${timestamp}`,
        });
        console.log(`HTTP Response Status: ${res.statusCode}`);
        console.log('Response Payload:', JSON.stringify(res.data, null, 2));
      } catch (err: any) {
        console.error('Request failed:', err.message);
      }
      console.log('\nPress ENTER to continue...');
      rl.question('', () => {
        printBanner();
        promptMenu();
      });
      break;

    case '2':
      console.log('\n---------------------------------------------------------------');
      console.log('  RUNNING AUTOMATED IDEMPOTENCY TEST');
      console.log('---------------------------------------------------------------');
      const testKey = `auto_idemp_${timestamp}`;

      console.log(`\n[STEP 1] Dispatching initial job with idempotencyKey: "${testKey}"...`);
      try {
        const res1 = await postPromise('/api/jobs/email', {
          to: 'alex@company.com',
          subject: 'Idempotency Test Email',
          body: 'First execution run.',
          idempotencyKey: testKey,
        });
        console.log(`Step 1 Status: ${res1.statusCode} OK -> Queued for worker processing.`);
      } catch (err: any) {
        console.error('Step 1 failed:', err.message);
      }

      console.log(`\n[STEP 2] Dispatching DUPLICATE job with SAME idempotencyKey: "${testKey}"...`);
      try {
        const res2 = await postPromise('/api/jobs/email', {
          to: 'alex@company.com',
          subject: 'Idempotency Test Email',
          body: 'Duplicate execution run.',
          idempotencyKey: testKey,
        });
        console.log(`Step 2 Status: ${res2.statusCode} OK -> Queued.`);
      } catch (err: any) {
        console.error('Step 2 failed:', err.message);
      }

      console.log('\n---------------------------------------------------------------');
      console.log('✔ Test Dispatched!');
      console.log('Check your `npm run dev` server terminal to verify the log:');
      console.log('  "[WARN] Duplicate job execution blocked by SQLite primary datastore..."');
      console.log('---------------------------------------------------------------');

      console.log('\nPress ENTER to continue...');
      rl.question('', () => {
        printBanner();
        promptMenu();
      });
      break;

    case '3':
      console.log('\nSending Financial Report Job...');
      try {
        const res = await postPromise('/api/jobs/report', {
          reportType: 'FINANCIAL',
          userEmail: 'finance@company.com',
          filters: { year: 2026, quarter: 'Q4' },
          idempotencyKey: `cli_report_${timestamp}`,
        });
        console.log(`HTTP Response Status: ${res.statusCode}`);
        console.log('Response Payload:', JSON.stringify(res.data, null, 2));
      } catch (err: any) {
        console.error('Request failed:', err.message);
      }
      console.log('\nPress ENTER to continue...');
      rl.question('', () => {
        printBanner();
        promptMenu();
      });
      break;

    case '4':
      console.log('\nSending Failure Simulation Job (will fail 3 times & move to DLQ)...');
      try {
        const res = await postPromise('/api/jobs/report', {
          reportType: 'ANALYTICS',
          userEmail: 'admin@company.com',
          filters: { debug: true },
          idempotencyKey: `cli_fail_${timestamp}`,
          simulateFailure: true,
        });
        console.log(`HTTP Response Status: ${res.statusCode}`);
        console.log('Response Payload:', JSON.stringify(res.data, null, 2));
        console.log('\nCheck Bull Board (http://localhost:3000/admin/queues) under `dlq-task-queue` to see the failed job!');
      } catch (err: any) {
        console.error('Request failed:', err.message);
      }
      console.log('\nPress ENTER to continue...');
      rl.question('', () => {
        printBanner();
        promptMenu();
      });
      break;

    case '5':
      console.log('\nChecking System Health...');
      makeGetRequest('/health', promptMenu);
      break;

    case '6':
      console.log('\nFetching Metrics Summary...');
      makeGetRequest('/metrics', promptMenu);
      break;

    case '7':
      console.log('\nExiting CLI. Goodbye!');
      rl.close();
      process.exit(0);
      break;

    default:
      console.log('\nInvalid choice. Please select 1-7.');
      setTimeout(() => {
        printBanner();
        promptMenu();
      }, 1000);
      break;
  }
}

printBanner();
promptMenu();
