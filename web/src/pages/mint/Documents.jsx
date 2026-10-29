// eBL, invoice and insurance upload for the selected case. Files go to the agent's ingest pipeline
// (actual bytes, base64); each job's steps, extracted fields with their source lines, compliance
// screening and findings are listed, and refresh live from the case's activity stream.
// A public sample is never written: uploads, jobs and the stream use this browser's own working copy of it.
// The page's entry bar asks for a file chooser or the first held job through the events below.
// Jobs come a page at a time, those waiting for a correction first, with the server's totals: a held job is never
// hidden behind newer ones, and the count of held jobs is the server's, not the length of a page. Each job says where
// it stands in its review chain, so a version a later correction took over is not offered as another to-do.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp, useLang } from '../../state/hooks.js';
import { t } from '../../lib/i18n.js';
import { agentRequest } from '../../lib/agent-api.js';
import { noteIntakeJobs, openWorkspaceCase, refreshWorkspaceCases } from '../../state/controller.js';
import { fileDocument, MAX_BATCH_BYTES, MAX_FILES } from '../../lib/documents.js';
import { Badge, Button, Card, CardHead, Disclosure } from '../../components/ui.jsx';
import { Icon } from '../../components/Icon.jsx';
import { DecisionButton } from '../../features/evidence/References.jsx';
import { Compliance } from './Compliance.jsx';
import { scrollBehavior } from '../../lib/accessibility.js';

const JOB_TONE = { DONE: 'ok', RUNNING: 'info', QUEUED: 'muted', FAILED: 'crit', INTERRUPTED: 'warn', WITHDRAWN: 'muted' };
// Intake refusals with their own sentence; anything else keeps the server's message.
const UPLOAD_ERRORS = new Set(['upload_quota_exceeded', 'upload_batch_too_large', 'intake_storage_full', 'operations_not_ready', 'duplicate_asset_documents',
  'upload_job_quota_exceeded', 'intake_jobs_full', 'review_capacity_exhausted', 'case_access_unavailable', 'job_not_withdrawable', 'review_in_progress']);
const PAGE = 8, MAX_PAGE = 200;
export const UPLOAD_REQUEST = 'agentbl:upload-request';
export const REVIEW_REQUEST = 'agentbl:review-request';
// A finished upload that produced a case: that case can be priced on this page instead of the sample.
const opened = (job) => job.status === 'DONE' && ['OPEN', 'OPEN_WITH_WARNING'].includes(job.result_action);
const mib = (bytes) => `${(Number(bytes) / 1_048_576).toFixed(1)} MiB`;
// What a capacity refusal means here: what is used, the limit, the held jobs that hold it, and what to do next.
function capacityDetail(details) {
  if (!Number.isFinite(details?.used_bytes) || !Number.isFinite(details?.limit_bytes)) return '';
  return ` ${t('ebld_capacity_detail', { used: mib(details.used_bytes), limit: mib(details.limit_bytes), held: details.held_jobs ?? 0 })} ${t(details.next_step === 'correct_or_withdraw_held_jobs' ? 'ebld_capacity_next_held' : 'ebld_capacity_next_wait')}`;
}
const uploadError = (failure) => UPLOAD_ERRORS.has(failure?.code) ? `${t(`ebld_error_${failure.code}`)}${capacityDetail(failure.details)}` : failure.message;
// A job that waits for corrected documents (an older server without review states: every held job does).
const reviewOpen = (job) => job.review_state ? job.review_state === 'open' : job.status === 'DONE' && Boolean(job.review_required);
const withdrawable = (job) => reviewOpen(job) || ['FAILED', 'INTERRUPTED'].includes(job.status);

/** Every job up to `count`, in the server's order, a page of at most MAX_PAGE at a time. */
async function fetchJobs(caseId, count) {
  const seen = new Map();
  let total = 0, held = 0;
  for (let offset = 0; offset < count;) {
    const data = await agentRequest(`/api/agent/jobs?case_id=${encodeURIComponent(caseId)}&limit=${Math.min(MAX_PAGE, count - offset)}&offset=${offset}`);
    for (const job of data.jobs ?? []) if (!seen.has(job.job_id)) seen.set(job.job_id, job);
    total = data.total ?? seen.size; held = data.held_total ?? [...seen.values()].filter(reviewOpen).length;
    if (data.next_offset == null) break;
    offset = data.next_offset;
  }
  return { jobs: [...seen.values()], total, held };
}

export function Documents() {
  useLang();
  const sourceCaseId = useApp((s) => s.caseId);
  // Until the copy is resolved nothing is listed or uploaded, so a sample's public jobs never stand in for the copy's.
  const caseId = useApp((s) => s.workspaceCaseId);
  const generation = useApp((s) => s.modeGeneration);
  const copyFailed = useApp((s) => s.caseLoad?.step === 'workspace');
  const [jobs, setJobs] = useState([]);
  const [total, setTotal] = useState(0);
  const [heldTotal, setHeldTotal] = useState(0);
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const input = useRef(null);
  const reviewId = useRef(null);
  const version = useRef(0);
  const shown = useRef(PAGE);
  const announced = useRef(new Set());

  const refresh = useCallback(async (forCase, requestVersion) => {
    try {
      const data = await fetchJobs(forCase, shown.current);
      if (requestVersion !== version.current) return;
      setJobs(data.jobs);
      setTotal(data.total);
      setHeldTotal(data.held);
      noteIntakeJobs(forCase, data.held);
      // The case a finished upload produced belongs in the case selector ("My working cases"): ask once per such job.
      // A review that changed the selected case's material makes the page reprice it (refreshWorkspaceCases follows it).
      const fresh = data.jobs.filter((job) => opened(job) && !announced.current.has(job.job_id));
      if (fresh.length) {
        for (const job of fresh) announced.current.add(job.job_id);
        refreshWorkspaceCases();
      }
    } catch (failure) {
      if (requestVersion === version.current) setError(failure.message);
    }
  }, []);

  useEffect(() => {
    const requestVersion = ++version.current;
    shown.current = PAGE;
    setJobs([]); setTotal(0); setHeldTotal(0); setError(''); setConfirming(null); reviewId.current = null;
    if (!caseId) return undefined;
    refresh(caseId, requestVersion);
    if (typeof EventSource === 'undefined') return undefined;
    const stream = new EventSource(`/api/agent/activity/stream?case_id=${encodeURIComponent(caseId)}`);
    stream.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.type === 'activity' && ['PIPELINE_STEP', 'INGEST_STARTED', 'INGEST_FINISHED'].includes(data.action)) refresh(caseId, requestVersion);
    };
    return () => stream.close();
  }, [caseId, generation, refresh]);

  // The entry bar's "upload my documents": a fresh upload, never a review a cancelled chooser left pending.
  useEffect(() => {
    const open = () => { if (busy || !caseId) return; reviewId.current = null; input.current?.click(); };
    const review = () => {
      const first = document.querySelector('.documents .job-review button');
      first?.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
      first?.focus({ preventScroll: true });
    };
    window.addEventListener(UPLOAD_REQUEST, open);
    window.addEventListener(REVIEW_REQUEST, review);
    return () => { window.removeEventListener(UPLOAD_REQUEST, open); window.removeEventListener(REVIEW_REQUEST, review); };
  }, [busy, caseId]);

  const upload = async (files) => {
    if (busy || !files?.length) return;
    if (files.length > MAX_FILES) { setError(t('ebld_too_many')); return; }
    if (Array.from(files).reduce((sum, file) => sum + file.size, 0) > MAX_BATCH_BYTES) { setError(t('ebld_batch_too_large', { mb: MAX_BATCH_BYTES / 1_048_576 })); return; }
    if (!caseId) return;
    const requestVersion = version.current, forCase = caseId, reviewing = reviewId.current;
    reviewId.current = null;
    setBusy(true); setError('');
    try {
      const documents = await Promise.all(Array.from(files).map((file) => fileDocument(file)));
      const path = reviewing ? `/api/agent/jobs/${encodeURIComponent(reviewing)}/review` : '/api/agent/ingest';
      const data = await agentRequest(path, { method: 'POST', body: reviewing ? { documents, note: 'Corrected documents submitted for deterministic re-evaluation.' } : { case_id: forCase, documents } });
      if (requestVersion !== version.current) return;
      setJobs((current) => [data.job, ...current.filter((job) => job.job_id !== data.job.job_id)]);
      await refresh(forCase, requestVersion);
    } catch (failure) {
      if (requestVersion === version.current) setError(uploadError(failure));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const showMore = () => {
    shown.current = Math.max(shown.current, jobs.length) + PAGE;
    return refresh(caseId, version.current);
  };

  // Withdrawing gives a held (or failed) job up: its raw files go now, its review decisions and evidence stay.
  const withdraw = async (job) => {
    if (busy || !caseId) return;
    const requestVersion = version.current, forCase = caseId;
    setBusy(true); setError('');
    try {
      await agentRequest(`/api/agent/jobs/${encodeURIComponent(job.job_id)}/withdraw`, { method: 'POST', body: {} });
      if (requestVersion === version.current) await refresh(forCase, requestVersion);
    } catch (failure) {
      if (requestVersion === version.current) setError(uploadError(failure));
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  return (
    <Card className="documents" id="ebl-documents" aria-labelledby="ebl-docs-h">
      <CardHead id="ebl-docs-h" title={t('ebl_upload_h')} level={3} />
      <div
        id="ebl-upload-zone"
        className={`dropzone${dragging ? ' is-dragging' : ''}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); reviewId.current = null; upload(event.dataTransfer.files); }}
      >
        <Icon name="upload" size={22} />
        <p>{t('ebl_upload_drop')}</p>
        <p className="muted small">
          {t('ebl_upload_or')}{' '}
          <button id="ebl-browse-btn" type="button" className="link-btn" disabled={busy || !caseId} onClick={() => { reviewId.current = null; input.current?.click(); }}>{t('ebl_upload_browse')}</button>{' '}
          {t('ebl_upload_device')}
        </p>
        <p className="muted small">{t('ebl_upload_types')}</p>
        <p className="muted small" id="ebl-workspace-scope">{t('ebld_workspace_scope')}</p>
        {caseId && caseId !== sourceCaseId ? <p className="muted small">{t('ebld_workspace_copy', { id: caseId, source: sourceCaseId })}</p> : null}
        <input ref={input} id="ebl-file-input" type="file" accept=".md,.txt,.pdf,.png,.jpg,.jpeg" multiple hidden onChange={(event) => upload(event.target.files)} />
      </div>
      <div id="ebl-upload-status" className="jobs" aria-live="polite">
        {error ? <p className="cp-warning">{error}</p> : null}
        {busy ? <p role="status" className="muted">{t('ebld_uploading')}</p> : null}
        {!caseId ? <p className={copyFailed ? 'cp-warning' : 'muted small'}>{t(copyFailed ? 'ebld_copy_failed' : 'ebld_waiting_copy')}</p> : null}
        {total ? <p className="muted small" id="ebl-jobs-summary">{t('ebld_jobs_summary', { total, held: heldTotal })}</p> : null}
        {jobs.map((job) => (
          <section key={job.job_id} className={`job${reviewOpen(job) ? ' is-open' : ''}`} data-job-id={job.job_id}>
            <header className="job-head">
              <strong>{t('ebld_job')}</strong>
              <Badge tone={JOB_TONE[job.status] ?? 'muted'}>{t(`ebld_status_${job.status}`)}</Badge>
              {job.result_action && job.status !== 'WITHDRAWN' ? <span className="muted small">{t(`ebld_action_${job.result_action}`)}</span> : null}
              <span className="muted small job-id">{job.job_id}</span>
            </header>
            {job.steps?.length ? (
              <ol className="job-steps">
                {job.steps.map((step) => (
                  <li key={step.step} className={`job-step is-${String(step.status).toLowerCase()}`}>
                    <span>{t(`ebld_step_${step.step}`)}</span><span className="muted small">{t(`ebld_step_status_${step.status}`)}</span>
                  </li>
                ))}
              </ol>
            ) : null}
            {job.compliance ? <Compliance report={job.compliance} /> : null}
            {(job.extraction ?? []).map((document) => {
              const extractor = document.source?.extractor;
              const sourceLabel = t(extractor === 'pdf-text' ? 'ebld_source_pdf' : extractor === 'llm-vision' ? 'ebld_source_vision' : 'ebld_source_text');
              return (
                <Disclosure key={document.source?.filename ?? document.document_type}
                  summary={`${document.source?.filename ?? document.document_type} · ${sourceLabel} · ${t('ebld_confidence')}: ${Math.round(document.confidence * 100)}%`}>
                  {extractor === 'llm-vision' ? <p className="cp-warning">{t('ebld_vision_review_hint')}</p> : null}
                  {document.source?.total_pages ? <p>{`${t('ebld_pages')}: ${document.source.total_pages}`}</p> : null}
                  {document.missing_fields?.length ? <p className="cp-warning">{`${t('ebld_missing_fields')}: ${document.missing_fields.map((name) => t(`ebld_field_${name}`)).join(', ')}`}</p> : null}
                  <dl className="field-list">
                    {Object.entries(document.fields).map(([name, value]) => {
                      const source = document.provenance[name];
                      const location = source?.page ? `${t('ebld_page')}: ${source.page} · ` : '';
                      return (
                        <div key={name}>
                          <dt>{t(`ebld_field_${name}`)}</dt>
                          <dd>{String(value)} <span className="muted small">{`(${location}${t('ebld_line')}: ${source?.line ?? '—'} · ${source?.method ?? '—'})`}</span></dd>
                        </div>
                      );
                    })}
                  </dl>
                </Disclosure>
              );
            })}
            {(job.findings ?? []).map((finding, index) => {
              const key = `ebld_reason_${finding.kind?.startsWith('COMPLIANCE_') ? finding.kind : finding.code ?? finding.kind}`, translated = t(key);
              return <p key={index} className={finding.severity === 'info' ? 'muted' : 'cp-warning'}>{translated === key ? finding.detail : translated}</p>;
            })}
            {(job.decision_ids ?? []).map((id) => <DecisionButton key={id} id={id} />)}
            {job.review_state === 'superseded' ? <p className="muted small">{t('ebld_review_superseded', { id: job.reviewed_by ?? '—' })}</p> : null}
            {job.review_state === 'resolved' ? <p className="muted small">{t('ebld_review_resolved', { id: job.reviewed_by ?? '—' })}</p> : null}
            {job.status === 'WITHDRAWN' ? <p className="muted small">{t('ebld_withdrawn_note')}</p> : null}
            {opened(job) ? (job.case_id === sourceCaseId
              ? <p className="muted small">{t('ebld_using_case')}</p>
              : <Button variant="primary" size="sm" disabled={busy} onClick={() => openWorkspaceCase(job.case_id)}>{t('ebld_use_case')}</Button>) : null}
            {job.error && job.status !== 'WITHDRAWN' ? <p className="cp-warning">{job.error.message}</p> : null}
            {reviewOpen(job) ? (
              <div className="job-review">
                <p>{t('ebld_review_hint')}</p>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => { reviewId.current = job.job_id; input.current?.click(); }}>{t('ebld_review_upload')}</Button>
              </div>
            ) : null}
            {withdrawable(job) ? (confirming === job.job_id ? (
              <div className="job-withdraw" role="group" aria-label={t('ebld_withdraw')}>
                <p className="small">{t('ebld_withdraw_confirm')}</p>
                <Button className="job-withdraw-yes" variant="danger" size="sm" disabled={busy} onClick={() => withdraw(job)}>{t('ebld_withdraw_yes')}</Button>{' '}
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(null)}>{t('ebld_withdraw_no')}</Button>
              </div>
            ) : <Button className="job-withdraw-open" variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(job.job_id)}>{t('ebld_withdraw')}</Button>) : null}
          </section>
        ))}
        {total > jobs.length ? <Button id="ebl-jobs-more" variant="secondary" size="sm" disabled={busy} onClick={showMore}>{t('ebld_jobs_more', { n: total - jobs.length })}</Button> : null}
        {caseId && !jobs.length && !busy && !error ? <p className="muted small">{t('ebld_no_jobs')}</p> : null}
      </div>
    </Card>
  );
}
