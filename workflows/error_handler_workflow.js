import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

// Fires whenever any workflow that names this one as its error workflow fails.
// The Error Trigger payload is { workflow: {id,name}, execution: {id,url,error,lastNodeExecuted,mode} }.
// On a trigger-level failure `execution` can be absent, so every read is guarded.
const onFailure = trigger({
  type: 'n8n-nodes-base.errorTrigger',
  version: 1,
  config: { name: 'On Any GBP Failure' }
});

const emailFailure = node({
  type: 'n8n-nodes-base.gmail',
  version: 2.2,
  config: {
    name: 'Email Failure Alert',
    parameters: {
      resource: 'message',
      operation: 'send',
      sendTo: 'kn0733@gmail.com',
      subject: expr('GBP FAILURE: {{ $json.workflow?.name || "unknown workflow" }}'),
      emailType: 'html',
      message: expr([
        '<h2 style="color:#b91c1c;margin-bottom:4px">A GBP workflow failed</h2>',
        '<p style="color:#71717a;margin-top:0">Nothing was retried automatically. If this was the audit, no report went out.</p>',
        '<table cellpadding="6" style="border-collapse:collapse;font-size:14px">',
        '<tr><td style="color:#71717a">Workflow</td><td><strong>{{ $json.workflow?.name || "unknown" }}</strong></td></tr>',
        '<tr><td style="color:#71717a">Failed at node</td><td><strong>{{ $json.execution?.lastNodeExecuted || "trigger or startup" }}</strong></td></tr>',
        '<tr><td style="color:#71717a">Execution</td><td>{{ $json.execution?.id || "n/a" }}</td></tr>',
        '<tr><td style="color:#71717a">Mode</td><td>{{ $json.execution?.mode || "n/a" }}</td></tr>',
        '<tr><td style="color:#71717a">When</td><td>{{ $now.toISO() }}</td></tr>',
        '</table>',
        '<h3>Error</h3>',
        '<pre style="background:#fef2f2;border-left:3px solid #b91c1c;padding:12px;border-radius:4px;overflow-x:auto;font-size:13px;white-space:pre-wrap">{{ $json.execution?.error?.message || $json.trigger?.error?.message || "No message supplied by n8n" }}</pre>',
        '<h3>Stack</h3>',
        '<pre style="background:#f4f4f5;padding:12px;border-radius:4px;overflow-x:auto;font-size:12px;white-space:pre-wrap">{{ ($json.execution?.error?.stack || "none").slice(0, 1500) }}</pre>',
        '<p><a href="{{ $json.execution?.url || "https://n8n.assignover.in/home/executions" }}">Open this execution in n8n</a></p>',
        '<p style="color:#71717a;font-size:12px">Sent by GBP Error Handler.</p>'
      ].join('')),
      options: { appendAttribution: false, senderName: 'GBP Automation' }
    },
    credentials: {
      gmailOAuth2: { id: 'kSrGTNfsbOFylPXx', name: 'Gmail - info@negotrip.com' }
    }
  }
});

export default workflow('gbp-error-handler', 'GBP Error Handler')
  .add(onFailure)
  .to(emailFailure);
