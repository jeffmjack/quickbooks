// Centralized QBO OAuth + API client.
// This is the ONE place that handles token refresh, persistence, and authenticated requests.

const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const QBO_API_BASE = "https://quickbooks.api.intuit.com/v3/company";

type SupabaseClient = { from: (table: string) => any };

export class QBOClient {
  private sb: SupabaseClient;
  private clientId: string;
  private clientSecret: string;
  private accessToken = "";
  private refreshToken = "";
  private realmId = "";

  constructor(sb: SupabaseClient) {
    this.sb = sb;
    this.clientId = Deno.env.get("QBO_CLIENT_ID")!;
    this.clientSecret = Deno.env.get("QBO_CLIENT_SECRET")!;
    if (!this.clientId || !this.clientSecret) {
      throw new Error("QBO_CLIENT_ID and QBO_CLIENT_SECRET must be set");
    }
  }

  /** Load refresh token from DB, exchange for access token, persist rotation. */
  async init(): Promise<void> {
    // Load current refresh token from DB
    const { data, error } = await this.sb
      .from("qbo_tokens")
      .select("refresh_token, realm_id")
      .eq("id", 1)
      .single();

    if (error || !data) {
      throw new Error(`Failed to load QBO tokens from DB: ${error?.message}`);
    }

    this.refreshToken = data.refresh_token;
    this.realmId = data.realm_id;

    await this._refreshAccessToken();
  }

  private async _refreshAccessToken(): Promise<void> {
    const resp = await fetch(QBO_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.refreshToken,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`QBO token refresh failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();

    if (!data.access_token) {
      throw new Error(`QBO token refresh returned no access_token: ${JSON.stringify(data)}`);
    }

    this.accessToken = data.access_token;

    // Persist rotated refresh token if Intuit changed it
    const newRefresh = data.refresh_token;
    if (newRefresh && newRefresh !== this.refreshToken) {
      this.refreshToken = newRefresh;
      await this.sb
        .from("qbo_tokens")
        .update({ refresh_token: newRefresh, updated_at: new Date().toISOString() })
        .eq("id", 1);
    }
  }

  /** Internal: make an authenticated request, retry once on 401. */
  private async _request(
    method: "GET" | "POST",
    path: string,
    options?: { params?: Record<string, string>; body?: unknown },
  ): Promise<unknown> {
    const doRequest = async () => {
      let url = `${QBO_API_BASE}/${this.realmId}/${path}`;
      if (options?.params) {
        const qs = new URLSearchParams(options.params).toString();
        url += `?${qs}`;
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
      };

      const init: RequestInit = { method, headers };

      if (method === "POST" && options?.body) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(options.body);
      }

      return await fetch(url, init);
    };

    let resp = await doRequest();

    // Retry once on 401 — token may have expired mid-session
    if (resp.status === 401) {
      await this._refreshAccessToken();
      resp = await doRequest();
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new QBOApiError(resp.status, text, path);
    }

    return await resp.json();
  }

  /** GET request to QBO API. */
  async get(path: string, params?: Record<string, string>): Promise<any> {
    return await this._request("GET", path, { params });
  }

  /** POST request to QBO API. */
  async post(path: string, body: unknown): Promise<any> {
    return await this._request("POST", path, { body });
  }

  /** Run a QBO SQL-style query, return the result rows. */
  async query(sql: string): Promise<any[]> {
    const data = await this.get("query", { query: sql }) as any;
    // QBO wraps results under QueryResponse.<EntityType>
    const qr = data?.QueryResponse || {};
    const key = Object.keys(qr).find((k) => k !== "startPosition" && k !== "maxResults" && k !== "totalCount");
    return key ? qr[key] : [];
  }

  /**
   * Check if a bill already exists in QBO.
   * Strategy: exact match on DocNumber + Vendor first, fallback to Vendor + Date + Amount.
   */
  async findBill(
    vendorQboId: string,
    invoiceNumber?: string | null,
    invoiceDate?: string | null,
    totalAmount?: number | null,
  ): Promise<any | null> {
    // Try exact match on invoice number first
    if (invoiceNumber) {
      const escaped = invoiceNumber.replace(/'/g, "\\'");
      const bills = await this.query(
        `SELECT * FROM Bill WHERE DocNumber = '${escaped}' AND VendorRef = '${vendorQboId}'`,
      );
      if (bills.length > 0) return bills[0];
    }

    // Fallback: vendor + date + amount (within $0.01 tolerance)
    if (invoiceDate && totalAmount != null) {
      const bills = await this.query(
        `SELECT * FROM Bill WHERE VendorRef = '${vendorQboId}' AND TxnDate = '${invoiceDate}'`,
      );
      for (const b of bills) {
        const qboTotal = parseFloat(b.TotalAmt || "0");
        if (Math.abs(qboTotal - totalAmount) < 0.02) {
          return b;
        }
      }
    }

    return null;
  }

  /**
   * Find a QBO customer by display name. Tries exact match first, then
   * a case-insensitive LIKE. Returns the best candidate or null.
   */
  async findCustomerByName(name: string): Promise<any | null> {
    const escaped = name.replace(/'/g, "\\'");
    const exact = await this.query(
      `SELECT * FROM Customer WHERE DisplayName = '${escaped}' AND Active = true`,
    );
    if (exact.length > 0) return exact[0];

    const like = await this.query(
      `SELECT * FROM Customer WHERE DisplayName LIKE '%${escaped}%' AND Active = true MAXRESULTS 5`,
    );
    return like.length > 0 ? like[0] : null;
  }

  /**
   * Fetch open (unpaid or partially paid) invoices for a customer.
   */
  async getOpenInvoicesForCustomer(customerQboId: string): Promise<any[]> {
    return await this.query(
      `SELECT * FROM Invoice WHERE CustomerRef = '${customerQboId}' AND Balance > '0' MAXRESULTS 100`,
    );
  }

  /**
   * Fetch a single invoice by its DocNumber for a given customer.
   * QBO DocNumber is not globally unique, so we scope by customer.
   */
  async findInvoiceByDocNumber(
    customerQboId: string,
    docNumber: string,
  ): Promise<any | null> {
    const escaped = docNumber.replace(/'/g, "\\'");
    const rows = await this.query(
      `SELECT * FROM Invoice WHERE CustomerRef = '${customerQboId}' AND DocNumber = '${escaped}'`,
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Fetch all invoices with the given DocNumber across all customers.
   * Each result carries CustomerRef inline ({value, name}). Caller is
   * responsible for disambiguating when multiple invoices share a number.
   */
  async findInvoicesByDocNumber(docNumber: string): Promise<any[]> {
    const escaped = docNumber.replace(/'/g, "\\'");
    return await this.query(
      `SELECT * FROM Invoice WHERE DocNumber = '${escaped}' MAXRESULTS 10`,
    );
  }

  /**
   * Find an existing Receive Payment by PaymentRefNum (our Ramp Payment ID).
   * Used as a post-side dedupe check so a retried `post-ramp-payment` invocation
   * doesn't create a duplicate Receive Payment in QBO. Returns the first match
   * or null. Ramp Payment IDs are globally unique so a single hit is reliable.
   */
  async findReceivePaymentByRefNum(refNum: string): Promise<any | null> {
    const escaped = refNum.replace(/'/g, "\\'");
    const rows = await this.query(
      `SELECT * FROM Payment WHERE PaymentRefNum = '${escaped}' MAXRESULTS 5`,
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Create a Receive Payment in QBO linked to a single Invoice.
   * Caller is responsible for confirming the invoice is open and the amount
   * matches before invoking — this method just builds and posts the payload.
   */
  async createReceivePayment(args: {
    customerQboId: string;
    invoiceQboId: string;
    amount: number;
    txnDate: string;             // ISO YYYY-MM-DD
    depositToAccountQboId: string;
    paymentMethodQboId?: string;
    paymentRefNum?: string;       // ≤21 chars; QBO will reject longer
    privateNote?: string;
  }): Promise<any> {
    const payload: Record<string, unknown> = {
      TxnDate: args.txnDate,
      CustomerRef: { value: args.customerQboId },
      TotalAmt: args.amount,
      DepositToAccountRef: { value: args.depositToAccountQboId },
      Line: [
        {
          Amount: args.amount,
          LinkedTxn: [{ TxnId: args.invoiceQboId, TxnType: "Invoice" }],
        },
      ],
    };
    if (args.paymentMethodQboId) {
      payload.PaymentMethodRef = { value: args.paymentMethodQboId };
    }
    if (args.paymentRefNum) {
      payload.PaymentRefNum = args.paymentRefNum;
    }
    if (args.privateNote) {
      payload.PrivateNote = args.privateNote;
    }
    return await this.post("payment", payload);
  }

  get companyId(): string {
    return this.realmId;
  }
}

export class QBOApiError extends Error {
  status: number;
  body: string;
  path: string;

  constructor(status: number, body: string, path: string) {
    super(`QBO API error ${status} on ${path}: ${body}`);
    this.name = "QBOApiError";
    this.status = status;
    this.body = body;
    this.path = path;
  }
}
