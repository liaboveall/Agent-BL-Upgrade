import { el, clear } from '../dom.js';
import { state } from '../store.js';
import { t, onLangChange } from '../i18n.js';
import { agentRequest } from './api.js';
import { decisionButton } from '../copilot/ui.js';

export const MAX_FILE_BYTES = 8_388_608;
export function fileDocument(file, Reader = FileReader) {
  if (file.size > MAX_FILE_BYTES) return Promise.reject(new Error(t('ebld_too_large')));
  const extension = file.name.split('.').at(-1).toLowerCase();
  const mime = file.type || ({ md: 'text/markdown', txt: 'text/plain', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }[extension]);
  return new Promise((resolve, reject) => {
    const reader = new Reader();
    reader.onerror = () => reject(new Error(t('ebld_read_failed')));
    reader.onload = () => resolve({ name: file.name, mime_type: mime, content_base64: String(reader.result).split(',').slice(1).join(',') });
    reader.readAsDataURL(file);
  });
}

export function initDocumentManagement() {
  const input = document.querySelector('#ebl-file-input'), zone = document.querySelector('#ebl-upload-zone');
  const target = document.querySelector('#ebl-upload-status');
  if (!input || !zone || !target) return;
  let reviewId = null, busy = false, selectedCase = null, generation = 0, stream = null, refreshVersion = 0, errorText = '';
  const latest = new Map();
  const render = () => {
    clear(target);
    if (errorText) target.append(el('p', { class: 'cp-warning' }, errorText));
    if (busy) target.append(el('p', { role: 'status' }, t('ebld_uploading')));
    for (const job of latest.values()) {
      const card = el('section', { class: 'ebl-job' }, el('strong', {}, `${t('ebld_job')}: ${t(`ebld_status_${job.status}`)}`));
      for (const step of job.steps ?? []) card.append(el('div', {}, `${t(`ebld_step_${step.step}`)} · ${t(`ebld_step_status_${step.status}`)}`));
      if (job.result_action) card.append(el('p', {}, t(`ebld_action_${job.result_action}`)));
      for (const document of job.extraction ?? []) {
        const details = el('details', {}, el('summary', {}, `${document.source?.filename ?? document.document_type} · ${t('ebld_confidence')}: ${Math.round(document.confidence * 100)}%`));
        const fields = el('dl', { class: 'ebl-fields' });
        for (const [name, value] of Object.entries(document.fields)) {
          const source = document.provenance[name];
          fields.append(el('dt', {}, t(`ebld_field_${name}`)), el('dd', {}, `${value} (${t('ebld_line')}: ${source?.line ?? '—'} · ${source?.method ?? '—'})`));
        }
        details.append(fields); card.append(details);
      }
      for (const finding of job.findings ?? []) card.append(el('p', { class: finding.severity === 'info' ? 'muted' : 'cp-warning' }, finding.detail));
      for (const id of job.decision_ids ?? []) card.append(decisionButton(id));
      if (job.error) card.append(el('p', { class: 'cp-warning' }, job.error.message));
      if (job.review_required) card.append(el('p', {}, t('ebld_review_hint')), el('button', { type: 'button', class: 'ghost', disabled: busy,
        onclick: () => { reviewId = job.job_id; input.click(); } }, t('ebld_review_upload')));
      target.append(card);
    }
  };
  async function refresh(caseId, requestGeneration) {
    const requestVersion = ++refreshVersion;
    try {
      const data = await agentRequest(`/api/agent/jobs?case_id=${encodeURIComponent(caseId)}&limit=8`);
      if (requestGeneration !== generation || requestVersion !== refreshVersion) return;
      latest.clear(); for (const job of data.jobs) latest.set(job.job_id, job); render();
    } catch (error) { if (requestGeneration === generation) target.textContent = error.message; }
  }
  function syncCase() {
    if (selectedCase === state.caseId) return;
    selectedCase = state.caseId; generation += 1; reviewId = null; errorText = ''; latest.clear(); render(); stream?.close();
    if (!selectedCase) return;
    const requestGeneration = generation, caseId = selectedCase;
    refresh(caseId, requestGeneration);
    stream = new EventSource(`/api/agent/activity/stream?case_id=${encodeURIComponent(caseId)}`);
    stream.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'activity' && ['PIPELINE_STEP', 'INGEST_STARTED', 'INGEST_FINISHED'].includes(data.action)) refresh(caseId, requestGeneration);
    };
  }
  async function upload(files) {
    if (busy || !files?.length) return;
    if (files.length > 12) { target.textContent = t('ebld_too_many'); return; }
    syncCase(); busy = true; errorText = ''; const caseId = selectedCase, requestGeneration = generation;
    const reviewing = reviewId; reviewId = null; render();
    try {
      const documents = await Promise.all(Array.from(files).map((file) => fileDocument(file)));
      const path = reviewing ? `/api/agent/jobs/${encodeURIComponent(reviewing)}/review` : '/api/agent/ingest';
      const data = await agentRequest(path, { method: 'POST', body: reviewing ? { documents, note: 'Corrected documents submitted for deterministic re-evaluation.' } : { case_id: caseId, documents } });
      if (requestGeneration !== generation) return;
      latest.set(data.job.job_id, data.job); render();
      await refresh(caseId, requestGeneration);
    } catch (error) { if (requestGeneration === generation) errorText = error.message; }
    finally { busy = false; input.value = ''; render(); }
  }
  document.querySelector('#ebl-browse-btn')?.addEventListener('click', () => { reviewId = null; input.click(); });
  input.addEventListener('change', () => upload(input.files));
  zone.addEventListener('dragover', (event) => event.preventDefault());
  zone.addEventListener('drop', (event) => { event.preventDefault(); reviewId = null; upload(event.dataTransfer.files); });
  window.addEventListener('agentbl:casechange', syncCase);
  window.addEventListener('agentbl:runtimechange', () => { selectedCase = null; reviewId = null; syncCase(); });
  window.addEventListener('beforeunload', () => stream?.close(), { once: true });
  onLangChange(render); syncCase();
}
