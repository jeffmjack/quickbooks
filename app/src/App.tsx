import { Routes, Route, Navigate, NavLink } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import Login from '@/pages/Login'
import PayrollDashboard from '@/pages/PayrollDashboard'
import Bills from '@/pages/Bills'
import BOM from '@/pages/BOM'
import Financials from '@/pages/Financials'
import { FileText, ChefHat, DollarSign, Users, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'

const NAV = [
  { to: '/bills', label: 'Bills', icon: FileText },
  { to: '/bom', label: 'BOM', icon: ChefHat },
  { to: '/financials', label: 'Financials', icon: DollarSign },
  { to: '/payroll', label: 'Payroll', icon: Users },
]

function AppShell() {
  const { user, signOut } = useAuth()

  return (
    <div className="min-h-screen flex">
      <aside className="w-56 border-r bg-sidebar flex flex-col">
        <div className="px-4 py-5 border-b">
          <h1 className="text-sm font-semibold text-sidebar-foreground">Green Cart</h1>
          <p className="text-xs text-muted-foreground">Finance Ops</p>
        </div>
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                    : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
                }`
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t px-3 py-3">
          <div className="text-xs text-muted-foreground truncate mb-2">
            {user?.email}
          </div>
          <Button variant="ghost" size="sm" className="w-full justify-start gap-2" onClick={signOut}>
            <LogOut className="size-3.5" />
            Sign out
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <div className="max-w-5xl mx-auto px-6 py-8">
          <Routes>
            <Route path="/bills" element={<Bills />} />
            <Route path="/bom" element={<BOM />} />
            <Route path="/financials" element={<Financials />} />
            <Route path="/payroll" element={<PayrollDashboard />} />
            <Route path="*" element={<Navigate to="/bills" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  )
}

export default function App() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    )
  }

  return user ? <AppShell /> : <Login />
}
