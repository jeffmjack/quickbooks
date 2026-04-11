import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { FileText, ChevronLeft, AlertTriangle, CheckCircle2, Clock, XCircle, RefreshCw, Loader2, Mail, Link2, Plus } from 'lucide-react'

const fmt = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

type Bill = {
  id: number
  vendor_id: number | null
  invoice_number: string | null
  invoice_date: string | null
  due_date: string | null
  total_amount: number | null
  status: string
  error_message: string | null
  drive_file_id: string | null
  drive_file_name: string | null
  email_message_id: string | null
  email_from: string | null
  email_subject: string | null
  source: string | null
  created_at: string
  raw_extraction: { vendor_name?: string } | null
  vendors: { name: string; qbo_vendor_id: string | null } | null
}

// Supabase returns joined relations as arrays; normalize to single object
function normalizeBill(raw: Record<string, unknown>): Bill {
  const r = { ...raw } as Record<string, unknown>
  if (Array.isArray(r.vendors)) r.vendors = r.vendors[0] ?? null
  return r as unknown as Bill
}

type LineItem = {
  id: number
  line_number: number
  description: string | null
  sku: string | null
  quantity: number | null
  unit: string | null
  unit_price: number | null
  extended_price: number | null
  mapping_confidence: number | null
  qbo_account_id: number | null
  qbo_accounts: { name: string; account_number: string | null } | null
}

type QboAccount = {
  id: number
  name: string
  account_number: string | null
}

// Simple Levenshtein similarity for vendor suggestion
function similarity(a: string, b: string): number {
  const al = a.toLowerCase(), bl = b.toLowerCase()
  if (al === bl) return 1
  const len = Math.max(al.length, bl.length)
  if (len === 0) return 1
  const matrix: number[][] = []
  for (let i = 0; i <= al.length; i++) { matrix[i] = [i] }
  for (let j = 0; j <= bl.length; j++) { matrix[0][j] = j }
  for (let i = 1; i <= al.length; i++) {
    for (let j = 1; j <= bl.length; j++) {
      matrix[i][j] = al[i - 1] === bl[j - 1]
        ? matrix[i - 1][j - 1]
        : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
    }
  }
  return 1 - matrix[al.length][bl.length] / len
}

type QboVendor = { id: number; name: string; qbo_vendor_id: string }

function VendorLinker({
  vendorId,
  vendorName,
  onLinked,
}: {
  vendorId: number
  vendorName: string
  onLinked: (qboVendorId: string) => void
}) {
  const [qboVendors, setQboVendors] = useState<QboVendor[]>([])
  const [search, setSearch] = useState('')
  const [linking, setLinking] = useState(false)
  const [creating, setCreating] = useState(false)
  const [result, setResult] = useState<{ message: string; isError: boolean } | null>(null)

  useEffect(() => {
    supabase
      .from('vendors')
      .select('id, name, qbo_vendor_id')
      .not('qbo_vendor_id', 'is', null)
      .order('name')
      .then(({ data }) => setQboVendors((data || []) as QboVendor[]))
  }, [])

  // Sort by similarity to vendor name, then filter by search
  const ranked = qboVendors
    .map((v) => ({ ...v, score: similarity(vendorName, v.name) }))
    .sort((a, b) => b.score - a.score)
  const filtered = search
    ? ranked.filter((v) => v.name.toLowerCase().includes(search.toLowerCase()))
    : ranked.slice(0, 8)

  const bestMatch = ranked.length > 0 && ranked[0].score >= 0.5 ? ranked[0] : null

  const linkVendor = async (qboVendorId: string) => {
    setLinking(true)
    setResult(null)
    try {
      const { data, error } = await supabase.functions.invoke('link-vendor', {
        body: { vendorId, qboVendorId },
      })
      if (error) {
        const body = error.context ? await error.context.json().catch(() => null) : null
        throw new Error(body?.error || error.message || `${error}`)
      }
      setResult({ message: data.message, isError: false })
      onLinked(qboVendorId)
    } catch (e: any) {
      setResult({ message: e.message || `Link failed: ${e}`, isError: true })
    } finally {
      setLinking(false)
    }
  }

  const createVendor = async () => {
    setCreating(true)
    setResult(null)
    try {
      const { data, error } = await supabase.functions.invoke('link-vendor', {
        body: { vendorId, createInQbo: true, createName: vendorName },
      })
      if (error) {
        const body = error.context ? await error.context.json().catch(() => null) : null
        throw new Error(body?.error || error.message || `${error}`)
      }
      setResult({ message: data.message, isError: false })
      onLinked(data.qbo_vendor_id)
    } catch (e: any) {
      setResult({ message: e.message || `Create failed: ${e}`, isError: true })
    } finally {
      setCreating(false)
    }
  }

  return (
    <Card className="border-amber-400">
      <CardContent className="py-4 space-y-3">
        <div className="flex items-start gap-2 text-amber-600">
          <AlertTriangle className="size-4 mt-0.5 shrink-0" />
          <p className="text-sm font-medium">
            "{vendorName}" is not linked to a QBO vendor
          </p>
        </div>

        {bestMatch && (
          <div className="flex items-center gap-2">
            <p className="text-sm text-muted-foreground">Best match:</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => linkVendor(bestMatch.qbo_vendor_id)}
              disabled={linking}
            >
              <Link2 className="size-3.5 mr-1.5" />
              {bestMatch.name}
              <span className="ml-1 text-muted-foreground">({Math.round(bestMatch.score * 100)}%)</span>
            </Button>
          </div>
        )}

        <div className="space-y-2">
          <Input
            placeholder="Search QBO vendors..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-sm"
          />
          {filtered.length > 0 && (
            <div className="max-h-40 overflow-y-auto border rounded-md divide-y text-sm">
              {filtered.map((v) => (
                <button
                  key={v.id}
                  className="w-full text-left px-3 py-1.5 hover:bg-muted/50 flex items-center justify-between disabled:opacity-50"
                  onClick={() => linkVendor(v.qbo_vendor_id)}
                  disabled={linking}
                >
                  <span>{v.name}</span>
                  <span className="text-muted-foreground text-xs">{Math.round(v.score * 100)}%</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 pt-1">
          <Button
            size="sm"
            variant="secondary"
            onClick={createVendor}
            disabled={creating || linking}
          >
            {creating ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <Plus className="size-3.5 mr-1.5" />}
            Create "{vendorName}" in QBO
          </Button>
        </div>

        {result && (
          <p className={`text-sm ${result.isError ? 'text-destructive' : 'text-muted-foreground'}`}>
            {result.message}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

const STATUS_CONFIG: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline'; className?: string; icon: typeof Clock }> = {
  pending:  { label: 'Pending Review', variant: 'outline', className: 'text-amber-600 border-amber-400', icon: Clock },
  reviewed: { label: 'Reviewed',       variant: 'secondary', icon: CheckCircle2 },
  posted:   { label: 'Posted to QBO',  variant: 'default', icon: CheckCircle2 },
  error:    { label: 'Error',          variant: 'outline', className: 'text-destructive border-destructive/40', icon: XCircle },
}

function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.pending
  const Icon = config.icon
  return (
    <Badge variant={config.variant} className={config.className}>
      <Icon className="size-3 mr-1" />
      {config.label}
    </Badge>
  )
}

// ── Bill List ───────────────────────────────────────────────────────────────

function ScanButton({
  onComplete,
  fn,
  label,
  activeLabel,
  icon: Icon,
}: {
  onComplete: () => void
  fn: string
  label: string
  activeLabel: string
  icon: typeof RefreshCw
}) {
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState<{ message: string; isError: boolean } | null>(null)

  const runScan = async () => {
    setScanning(true)
    setResult(null)
    try {
      const { data, error } = await supabase.functions.invoke(fn)
      if (error) {
        // Extract the response body from FunctionsHttpError
        const body = error.context ? await error.context.json().catch(() => null) : null
        throw new Error(body?.error || error.message || `${error}`)
      }
      setResult({ message: data.message, isError: false })
      onComplete()
    } catch (e: any) {
      setResult({ message: e.message || `Scan failed: ${e}`, isError: true })
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="flex items-center gap-3">
      <Button onClick={runScan} disabled={scanning} variant="outline" size="sm">
        {scanning ? (
          <Loader2 className="size-3.5 mr-1.5 animate-spin" />
        ) : (
          <Icon className="size-3.5 mr-1.5" />
        )}
        {scanning ? activeLabel : label}
      </Button>
      {result && (
        <p className={`text-sm ${result.isError ? 'text-destructive' : 'text-muted-foreground'}`}>
          {result.message}
        </p>
      )}
    </div>
  )
}

function ScanButtons({ onComplete }: { onComplete: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <ScanButton
        onComplete={onComplete}
        fn="scan-genie"
        label="Scan Drive"
        activeLabel="Scanning Drive..."
        icon={RefreshCw}
      />
      <ScanButton
        onComplete={onComplete}
        fn="scan-email"
        label="Scan Email"
        activeLabel="Scanning email..."
        icon={Mail}
      />
    </div>
  )
}

function BillList({ onSelect }: { onSelect: (id: number) => void }) {
  const [bills, setBills] = useState<Bill[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    async function load() {
      setLoading(true)
      let query = supabase
        .from('bills')
        .select('id, vendor_id, invoice_number, invoice_date, due_date, total_amount, status, error_message, drive_file_id, drive_file_name, email_message_id, email_from, email_subject, source, created_at, vendors(name, qbo_vendor_id)')
        .order('created_at', { ascending: false })

      if (filter) query = query.eq('status', filter)

      const { data } = await query
      setBills((data || []).map((d: Record<string, unknown>) => normalizeBill(d)))
      setLoading(false)
    }
    load()
  }, [filter, refreshKey])

  const reload = () => setRefreshKey((k) => k + 1)

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading bills...</p>
  }

  if (bills.length === 0 && !filter) {
    return (
      <div className="space-y-4">
        <ScanButtons onComplete={reload} />
        <Card>
          <CardContent className="py-12 text-center">
            <FileText className="size-10 mx-auto mb-3 text-muted-foreground/40" />
            <h3 className="font-medium mb-1">No bills yet</h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              Scan the Genie Drive folder or billing email inbox to pull in new invoices.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const statuses = ['pending', 'reviewed', 'posted', 'error']

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <Button
            variant={filter === null ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter(null)}
          >
            All
          </Button>
        {statuses.map((s) => (
          <Button
            key={s}
            variant={filter === s ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter(s)}
          >
            {STATUS_CONFIG[s]?.label || s}
          </Button>
        ))}
        </div>
        <ScanButtons onComplete={reload} />
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Vendor</TableHead>
              <TableHead>Invoice #</TableHead>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {bills.map((bill) => (
              <TableRow
                key={bill.id}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => onSelect(bill.id)}
              >
                <TableCell className="font-medium">
                  {bill.vendors?.name || 'Unknown vendor'}
                </TableCell>
                <TableCell className="font-mono text-sm text-muted-foreground">
                  {bill.invoice_number || '—'}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {bill.invoice_date || '—'}
                </TableCell>
                <TableCell className="text-right">
                  {bill.total_amount !== null ? fmt(bill.total_amount) : '—'}
                </TableCell>
                <TableCell>
                  <StatusBadge status={bill.status} />
                </TableCell>
                <TableCell className="text-sm text-muted-foreground truncate max-w-[160px]">
                  {bill.drive_file_id ? (
                    <a
                      href={`https://drive.google.com/file/d/${bill.drive_file_id}/view`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline text-blue-600"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {bill.source === 'email'
                        ? bill.email_subject || bill.email_from || 'Email'
                        : bill.drive_file_name || 'View file'}
                    </a>
                  ) : bill.email_message_id ? (
                    <a
                      href={`https://mail.google.com/mail/?authuser=billing@thegreencart.com#inbox/${bill.email_message_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline text-blue-600"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {bill.email_subject || bill.email_from || 'Email'}
                    </a>
                  ) : bill.source === 'email'
                    ? bill.email_subject || bill.email_from || 'Email'
                    : bill.drive_file_name || '—'
                  }
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}

// ── Bill Detail ─────────────────────────────────────────────────────────────

function BillDetail({ billId, onBack }: { billId: number; onBack: () => void }) {
  const [bill, setBill] = useState<Bill | null>(null)
  const [lines, setLines] = useState<LineItem[]>([])
  const [accounts, setAccounts] = useState<QboAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [savingLines, setSavingLines] = useState<Set<number>>(new Set())
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      const [billRes, linesRes, acctRes] = await Promise.all([
        supabase
          .from('bills')
          .select('id, invoice_number, invoice_date, due_date, total_amount, status, error_message, drive_file_id, drive_file_name, email_message_id, email_from, email_subject, source, raw_extraction, created_at, vendor_id, vendors(name, qbo_vendor_id)')
          .eq('id', billId)
          .single(),
        supabase
          .from('bill_line_items')
          .select('id, line_number, description, sku, quantity, unit, unit_price, extended_price, mapping_confidence, qbo_account_id, qbo_accounts(name, account_number)')
          .eq('bill_id', billId)
          .order('line_number'),
        supabase
          .from('qbo_accounts')
          .select('id, name, account_number')
          .order('account_number'),
      ])
      setBill(billRes.data ? normalizeBill(billRes.data as Record<string, unknown>) : null)
      setLines((linesRes.data || []).map((d: Record<string, unknown>) => {
        const r = { ...d } as Record<string, unknown>
        if (Array.isArray(r.qbo_accounts)) r.qbo_accounts = r.qbo_accounts[0] ?? null
        return r as unknown as LineItem
      }))
      setAccounts((acctRes.data as QboAccount[]) || [])
      setLoading(false)
    }
    load()
  }, [billId])

  const handleAccountChange = useCallback(async (lineId: number, accountId: number) => {
    const line = lines.find((l) => l.id === lineId)
    if (!line) return

    setSavingLines((prev) => new Set(prev).add(lineId))
    setSaveMsg(null)

    // Update line item
    await supabase
      .from('bill_line_items')
      .update({ qbo_account_id: accountId, mapping_confidence: 1.0 })
      .eq('id', lineId)

    // Update local state immediately
    const acct = accounts.find((a) => a.id === accountId)
    setLines((prev) =>
      prev.map((l) =>
        l.id === lineId
          ? { ...l, qbo_account_id: accountId, mapping_confidence: 1.0, qbo_accounts: acct ? { name: acct.name, account_number: acct.account_number } : null }
          : l
      )
    )

    // Create/update vendor_item_mapping for future auto-match
    const vendorId = bill?.vendor_id
    if (vendorId && line.description) {
      const { data: existing } = await supabase
        .from('vendor_item_mappings')
        .select('id')
        .eq('vendor_id', vendorId)
        .eq('item_description', line.description)
        .limit(1)

      if (existing && existing.length > 0) {
        await supabase
          .from('vendor_item_mappings')
          .update({ qbo_account_id: accountId, confidence: 1.0, updated_at: new Date().toISOString() })
          .eq('id', existing[0].id)
      } else {
        await supabase
          .from('vendor_item_mappings')
          .insert({
            vendor_id: vendorId,
            item_description: line.description,
            item_sku: line.sku,
            qbo_account_id: accountId,
            confidence: 1.0,
          })
      }
    }

    setSavingLines((prev) => {
      const next = new Set(prev)
      next.delete(lineId)
      return next
    })
    setSaveMsg('Saved')
  }, [lines, accounts, bill, billId])

  const [posting, setPosting] = useState(false)
  const [postResult, setPostResult] = useState<{ message: string; isError: boolean } | null>(null)

  const markReviewed = async () => {
    await supabase.from('bills').update({ status: 'reviewed' }).eq('id', billId)
    setBill((prev) => prev ? { ...prev, status: 'reviewed' } : prev)
  }

  const postToQBO = async () => {
    setPosting(true)
    setPostResult(null)
    try {
      const { data, error } = await supabase.functions.invoke('post-bill', {
        body: { billId },
      })
      if (error) {
        const body = error.context ? await error.context.json().catch(() => null) : null
        throw new Error(body?.error || error.message || `${error}`)
      }
      setPostResult({ message: data.message, isError: false })
      setBill((prev) => prev ? { ...prev, status: 'posted', qbo_bill_id: data.qbo_bill_id } : prev)
    } catch (e: any) {
      setPostResult({ message: e.message || `Post failed: ${e}`, isError: true })
    } finally {
      setPosting(false)
    }
  }

  const reviewAndPost = async () => {
    await supabase.from('bills').update({ status: 'reviewed' }).eq('id', billId)
    setBill((prev) => prev ? { ...prev, status: 'reviewed' } : prev)
    await postToQBO()
  }

  if (loading || !bill) {
    return <p className="text-sm text-muted-foreground">Loading...</p>
  }

  const unmapped = lines.filter((l) => !l.qbo_account_id)

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ChevronLeft className="size-4" />
        </Button>
        <div className="flex-1">
          <h2 className="text-xl font-semibold">
            {bill.vendors?.name || 'Unknown vendor'}
          </h2>
          <p className="text-sm text-muted-foreground">
            Invoice {bill.invoice_number || '—'} &middot; {bill.invoice_date || 'No date'}
            {bill.vendors?.qbo_vendor_id
              ? <span className="ml-2">&middot; QBO linked</span>
              : <span className="ml-2 text-amber-600">&middot; Not linked to QBO</span>
            }
          </p>
          {bill.raw_extraction?.vendor_name && bill.raw_extraction.vendor_name !== bill.vendors?.name && (
            <p className="text-xs text-muted-foreground">Name on bill: {bill.raw_extraction.vendor_name}</p>
          )}
        </div>
        <StatusBadge status={bill.status} />
      </div>

      {/* Vendor linking */}
      {bill.vendor_id && !bill.vendors?.qbo_vendor_id && (
        <VendorLinker
          vendorId={bill.vendor_id}
          vendorName={bill.vendors?.name || 'Unknown'}
          onLinked={(qboVendorId) => {
            setBill((prev) => prev ? {
              ...prev,
              vendors: { ...prev.vendors!, qbo_vendor_id: qboVendorId },
            } : prev)
          }}
        />
      )}

      {/* Warnings */}
      {unmapped.length > 0 && (
        <Card>
          <CardContent className="py-3">
            <div className="flex items-start gap-2 text-amber-600">
              <AlertTriangle className="size-4 mt-0.5 shrink-0" />
              <p className="text-sm">
                {unmapped.length} line{unmapped.length > 1 ? 's' : ''} need{unmapped.length === 1 ? 's' : ''} a category assignment
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Invoice #</dt>
            <dd className="font-mono">{bill.invoice_number || '—'}</dd>
            <dt className="text-muted-foreground">Date</dt>
            <dd>{bill.invoice_date || '—'}</dd>
            <dt className="text-muted-foreground">Due Date</dt>
            <dd>{bill.due_date || '—'}</dd>
            <dt className="text-muted-foreground">Total</dt>
            <dd className="font-semibold">{bill.total_amount !== null ? fmt(bill.total_amount) : '—'}</dd>
            <dt className="text-muted-foreground">Source</dt>
            <dd className="truncate">
              {bill.drive_file_id ? (
                <a
                  href={`https://drive.google.com/file/d/${bill.drive_file_id}/view`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline text-blue-600"
                >
                  {bill.source === 'email'
                    ? bill.email_subject || bill.email_from || 'Email'
                    : bill.drive_file_name || 'View file'}
                </a>
              ) : bill.email_message_id ? (
                <a
                  href={`https://mail.google.com/mail/?authuser=billing@thegreencart.com#inbox/${bill.email_message_id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline text-blue-600"
                >
                  {bill.email_subject || bill.email_from || 'Email'}
                </a>
              ) : bill.source === 'email' ? (
                <span title={bill.email_from || undefined}>
                  {bill.email_subject || bill.email_from || 'Email'}
                </span>
              ) : (
                bill.drive_file_name || '—'
              )}
            </dd>
          </dl>
        </CardContent>
      </Card>

      {/* Error message */}
      {bill.status === 'error' && bill.error_message && (
        <Card>
          <CardContent className="py-3">
            <div className="flex items-start gap-2 text-destructive">
              <XCircle className="size-4 mt-0.5 shrink-0" />
              <p className="text-sm">{bill.error_message}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Line Items */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Line Items</CardTitle>
              <CardDescription>{lines.length} item{lines.length !== 1 ? 's' : ''}</CardDescription>
            </div>
            {saveMsg && (
              <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                <CheckCircle2 className="size-3.5" />
                {saveMsg}
              </p>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">#</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Item #</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Ext. Price</TableHead>
                <TableHead className="w-[200px]">Category</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line) => {
                const isSaving = savingLines.has(line.id)

                return (
                  <TableRow key={line.id}>
                    <TableCell className="text-muted-foreground">{line.line_number}</TableCell>
                    <TableCell>
                      <p className="truncate text-sm max-w-[300px]">{line.description || '—'}</p>
                    </TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      {line.sku || '—'}
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      {line.quantity !== null ? `${line.quantity} ${line.unit || ''}`.trim() : '—'}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {line.extended_price !== null ? fmt(line.extended_price) : '—'}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Select
                          value={line.qbo_account_id?.toString() ?? ''}
                          onValueChange={(val) => handleAccountChange(line.id, parseInt(val as string))}
                        >
                          <SelectTrigger className={`h-8 text-sm ${!line.qbo_account_id ? 'border-amber-400 text-amber-600' : ''}`}>
                            <SelectValue placeholder="Select category">
                              {line.qbo_account_id
                                ? accounts.find((a) => a.id === line.qbo_account_id)?.name ?? 'Unknown'
                                : undefined}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {accounts.map((acct) => (
                              <SelectItem key={acct.id} value={acct.id.toString()}>
                                {acct.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {isSaving && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
              {lines.length > 0 && (
                <TableRow className="font-semibold border-t-2">
                  <TableCell colSpan={4} className="text-right">Total</TableCell>
                  <TableCell className="text-right font-mono">
                    {bill.total_amount !== null ? fmt(bill.total_amount) : '—'}
                  </TableCell>
                  <TableCell />
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Actions */}
      {(bill.status === 'pending' || bill.status === 'reviewed') && (
        <div className="flex flex-wrap gap-3 items-center">
          {bill.status === 'pending' && (
            <>
              <Button onClick={reviewAndPost} disabled={unmapped.length > 0 || posting}>
                {posting ? <Loader2 className="size-4 mr-1.5 animate-spin" /> : <CheckCircle2 className="size-4 mr-1.5" />}
                Review & Post to QBO
              </Button>
              <Button variant="outline" onClick={markReviewed} disabled={unmapped.length > 0}>
                <CheckCircle2 className="size-4 mr-1.5" />
                Mark as Reviewed
              </Button>
            </>
          )}
          {bill.status === 'reviewed' && (
            <Button onClick={postToQBO} disabled={unmapped.length > 0 || posting}>
              {posting ? <Loader2 className="size-4 mr-1.5 animate-spin" /> : <CheckCircle2 className="size-4 mr-1.5" />}
              Post to QBO
            </Button>
          )}
          {unmapped.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Assign all categories before posting
            </p>
          )}
          {postResult && (
            <p className={`text-sm ${postResult.isError ? 'text-destructive' : 'text-muted-foreground'}`}>
              {postResult.message}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main ────────────────────────────────────────────────────────────────────

export default function Bills() {
  const [selectedBillId, setSelectedBillId] = useState<number | null>(null)

  return (
    <div>
      {selectedBillId === null ? (
        <>
          <div className="mb-6">
            <h2 className="text-2xl font-semibold mb-1">Bills</h2>
            <p className="text-muted-foreground text-sm">
              Review and approve staged invoices before posting to QBO.
            </p>
          </div>
          <BillList onSelect={setSelectedBillId} />
        </>
      ) : (
        <BillDetail billId={selectedBillId} onBack={() => setSelectedBillId(null)} />
      )}
    </div>
  )
}
