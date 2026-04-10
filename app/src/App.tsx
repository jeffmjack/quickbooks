import PayrollDashboard from '@/pages/PayrollDashboard'

export default function App() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Green Cart — Finance Ops</h1>
            <p className="text-sm text-muted-foreground">Internal bookkeeping tools</p>
          </div>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-6 py-8">
        <PayrollDashboard />
      </main>
    </div>
  )
}
