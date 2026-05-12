import { useState } from "react";
import {
  useAdminGetSubAccountWebhookConfig,
  useAdminRotateSubAccountWebhookSecret,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Copy,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Webhook,
  Clock,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const CRM_LABEL: Record<string, string> = {
  ghl: "GoHighLevel",
  hubspot: "HubSpot",
  salesforce: "Salesforce",
};

function CopyField({
  value,
  testId,
  monospace = true,
}: {
  value: string;
  testId: string;
  monospace?: boolean;
}) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast({ title: "Copied to clipboard" });
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };
  return (
    <div className="flex items-center gap-2">
      <Input
        readOnly
        value={value}
        className={`h-8 ${monospace ? "font-mono text-xs" : ""}`}
        data-testid={`${testId}-input`}
      />
      <Button
        size="sm"
        variant="outline"
        onClick={onCopy}
        data-testid={`${testId}-copy`}
      >
        {copied ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </Button>
    </div>
  );
}

export function WebhookConfigRow({
  subAccountId,
  subAccountName,
}: {
  subAccountId: string;
  subAccountName: string;
}) {
  const { toast } = useToast();
  const { data, isLoading, refetch } =
    useAdminGetSubAccountWebhookConfig(subAccountId);
  const rotate = useAdminRotateSubAccountWebhookSecret();
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

  if (isLoading || !data) {
    return (
      <Card data-testid={`row-webhook-${subAccountId}`}>
        <CardContent className="p-4 text-sm text-muted-foreground">
          Loading…
        </CardContent>
      </Card>
    );
  }

  const handleRotate = () => {
    rotate.mutate(
      { id: subAccountId },
      {
        onSuccess: (res) => {
          setRevealedSecret(res.webhookSecret);
          toast({
            title: "Webhook secret rotated",
            description:
              "Copy it now — for security, the plaintext won't be shown again.",
          });
          refetch();
        },
        onError: () =>
          toast({ title: "Rotate failed", variant: "destructive" }),
      },
    );
  };

  const status = data.lastReceivedAt ? (
    data.lastSignatureOk ? (
      <span
        className="text-xs bg-green-500/10 text-green-500 px-2 py-0.5 rounded font-medium flex items-center gap-1"
        data-testid={`badge-webhook-status-${subAccountId}`}
      >
        <CheckCircle2 className="h-3 w-3" /> Last event OK
      </span>
    ) : (
      <span
        className="text-xs bg-red-500/10 text-red-500 px-2 py-0.5 rounded font-medium flex items-center gap-1"
        data-testid={`badge-webhook-status-${subAccountId}`}
      >
        <XCircle className="h-3 w-3" /> Last event failed
      </span>
    )
  ) : (
    <span
      className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded font-medium flex items-center gap-1"
      data-testid={`badge-webhook-status-${subAccountId}`}
    >
      <Clock className="h-3 w-3" /> No events yet
    </span>
  );

  const matchingUrl =
    data.crmType
      ? data.webhookUrls.find((u) => u.crm === data.crmType)?.url
      : null;
  const otherUrls = data.crmType
    ? data.webhookUrls.filter((u) => u.crm !== data.crmType)
    : data.webhookUrls;

  return (
    <Card data-testid={`row-webhook-${subAccountId}`}>
      <CardContent className="p-4 space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Webhook className="h-5 w-5 text-primary" />
            <div>
              <div
                className="font-bold text-lg"
                data-testid={`text-sub-name-${subAccountId}`}
              >
                {subAccountName}
              </div>
              <div className="text-sm text-muted-foreground">
                {data.crmType
                  ? `Configured CRM: ${CRM_LABEL[data.crmType] ?? data.crmType}`
                  : "No CRM configured"}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {data.secretSet ? (
              <span
                className="text-xs bg-green-500/10 text-green-500 px-2 py-0.5 rounded font-medium flex items-center gap-1"
                data-testid={`badge-secret-set-${subAccountId}`}
              >
                <CheckCircle2 className="h-3 w-3" /> Secret set
              </span>
            ) : (
              <span
                className="text-xs bg-amber-500/10 text-amber-500 px-2 py-0.5 rounded font-medium flex items-center gap-1"
                data-testid={`badge-secret-missing-${subAccountId}`}
              >
                <AlertTriangle className="h-3 w-3" /> No secret
              </span>
            )}
            {status}
          </div>
        </div>

        {matchingUrl && (
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
              Webhook URL — paste this into{" "}
              {CRM_LABEL[data.crmType ?? ""] ?? data.crmType}
            </div>
            <CopyField
              value={matchingUrl}
              testId={`webhook-url-${subAccountId}-${data.crmType}`}
            />
          </div>
        )}

        {otherUrls.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              Other CRM URLs (for switching)
            </summary>
            <div className="mt-2 space-y-2">
              {otherUrls.map((u) => (
                <div key={u.crm}>
                  <div className="text-xs text-muted-foreground mb-1">
                    {CRM_LABEL[u.crm] ?? u.crm}
                  </div>
                  <CopyField
                    value={u.url}
                    testId={`webhook-url-${subAccountId}-${u.crm}`}
                  />
                </div>
              ))}
            </div>
          </details>
        )}

        <div className="flex items-end justify-between gap-4 flex-wrap pt-2 border-t">
          <div className="text-sm space-y-1">
            <div className="text-muted-foreground">
              Last inbound event:{" "}
              <span
                className="text-foreground font-medium"
                data-testid={`text-last-received-${subAccountId}`}
              >
                {data.lastReceivedAt
                  ? new Date(data.lastReceivedAt).toLocaleString()
                  : "—"}
              </span>
              {data.lastEventType && (
                <span className="ml-2 text-xs text-muted-foreground">
                  ({data.lastEventType})
                </span>
              )}
            </div>
            {data.lastErrorReason && (
              <div className="text-xs text-red-500 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                Last signature error: {data.lastErrorReason}
                {data.lastErrorAt &&
                  ` · ${new Date(data.lastErrorAt).toLocaleString()}`}
              </div>
            )}
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                data-testid={`button-rotate-secret-${subAccountId}`}
              >
                <RefreshCw className="h-4 w-4 mr-1" />
                {data.secretSet ? "Rotate secret" : "Generate secret"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {data.secretSet
                    ? "Rotate webhook secret?"
                    : "Generate webhook secret?"}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {data.secretSet
                    ? "Any inbound webhook signed with the current secret will start failing as soon as the new secret is generated. You'll need to paste the new secret into the CRM right away."
                    : "A new signing secret will be generated for this sub-account. You'll need to paste it into the CRM webhook configuration."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleRotate}
                  data-testid={`button-confirm-rotate-${subAccountId}`}
                >
                  {data.secretSet ? "Rotate" : "Generate"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        {revealedSecret && (
          <div
            className="border border-amber-500/30 bg-amber-500/5 rounded-md p-3 space-y-2"
            data-testid={`panel-revealed-secret-${subAccountId}`}
          >
            <div className="text-xs font-semibold text-amber-500 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" /> New webhook secret — copy
              now, this won't be shown again
            </div>
            <CopyField
              value={revealedSecret}
              testId={`revealed-secret-${subAccountId}`}
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRevealedSecret(null)}
            >
              I've copied it — hide
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
