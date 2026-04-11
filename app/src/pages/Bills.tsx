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
import { FileText, ChevronLeft, AlertTriangle, CheckCircle2, Clock, XCircle, RefreshCw, Loader2 } from 'lucide-react'

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
  drive_file_name: string | null
  created_at: string
  vendors: { name: string } | null
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

function ConfidenceBadge({ confidence }: { confidence: number | null }) {
  if (confidence === null) return <span className="text-muted-foreground">—</span>
  const pct = Math.round(confidence * 100)
  if (pct >= 90) return <Badge variant="secondary">{pct}%</Badge>
  if (pct >= 70) return <Badge variant="outline" className="text-amber-600 border-amber-400">{pct}%</Badge>
  return <Badge variant="outline" className="text-destructive border-destructive/40">{pct}%</Badge>
}

// ── Bill List ───────────────────────────────────────────────────────────────

function ScanButton({ onComplete }: { onComplete: () => void }) {
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState<{ message: string; isError: boolean } | null>(null)

  const runScan = async () => {
    setScanning(true)
    setResult(null)
    try {
      const { data, error } = await supabase.functions.invoke('scan-genie')
      if (error) throw error
      setResult({ message: data.message, isError: false })
      onComplete()
    } catch (e) {
      setResult({ message: `Scan failed: ${e}`, isError: true })
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
          <RefreshCw className="size-3.5 mr-1.5" />
        )}
        {scanning ? 'Scanning Genie folder...' : 'Scan for new invoices'}
      </Button>
      {result && (
        <p className={`text-sm ${result.isError ? 'text-destructive' : 'text-muted-foreground'}`}>
          {result.message}
        </p>
      )}
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
        .select('id, invoice_number, invoice_date, due_date, total_amount, status, error_message, drive_file_name, created_at, vendors(name)')
        .order('created_at', { ascending: false })

      if (filter) query = query.eq('status', filter)

      const { data } = await query
      setBills((data as Bill[]) || [])
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
        <ScanButton onComplete={reload} />
        <Card>
          <CardContent className="py-12 text-center">
            <FileText className="size-10 mx-auto mb-3 text-muted-foreground/40" />
            <h3 className="font-medium mb-1">No bills yet</h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              Hit "Scan for new invoices" above to check the Genie folder for new invoices to process.
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
        <ScanButton onComplete={reload} />
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
              <TableHead>File</TableHead>
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
                  {bill.drive_file_name || '—'}
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
          .select('id, invoice_number, invoice_date, due_date, total_amount, status, error_message, drive_file_name, created_at, vendor_id, vendors(name)')
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
      setBill(billRes.data as Bill)
      setLines((linesRes.data as LineItem[]) || [])
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

  const markReviewed = async () => {
    await supabase.from('bills').update({ status: 'reviewed' }).eq('id', billId)
    setBill((prev) => prev ? { ...prev, status: 'reviewed' } : prev)
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
          </p>
        </div>
        <StatusBadge status={bill.status} />
      </div>

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
            <dt className="text-muted-foreground">Source File</dt>
            <dd className="truncate">{bill.drive_file_name || '—'}</dd>
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
                      <div className="max-w-[300px]">
                        <p className="truncate text-sm">{line.description || '—'}</p>
                        {line.sku && (
                          <p className="text-xs text-muted-foreground font-mono">{line.sku}</p>
                        )}
                      </div>
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
                  <TableCell colSpan={3} className="text-right">Total</TableCell>
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
      {bill.status === 'pending' && (
        <div className="flex gap-3">
          <Button onClick={markReviewed} disabled={unmapped.length > 0}>
            <CheckCircle2 className="size-4 mr-1.5" />
            Mark as Reviewed
          </Button>
          {unmapped.length > 0 && (
            <p className="text-sm text-muted-foreground self-center">
              Assign all categories before marking as reviewed
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
