
from django.conf import settings
from django.db import models
from django.utils import timezone


class Account(models.Model):
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="bank_account",
    )
    account_number = models.CharField(max_length=20, unique=True)
    balance = models.DecimalField(max_digits=12, decimal_places=2, default=1000)

    def __str__(self):
        return f"{self.user.username} · {self.account_number}"


class Transfer(models.Model):
    STATUS_CHOICES = [
        ("PENDING", "Pending"),
        ("COMPLETED", "Completed"),
        ("FAILED", "Failed"),
    ]

    transaction_id = models.CharField(max_length=40, unique=True)
    sender = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="sent_transfers",
    )
    receiver = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="received_transfers",
    )
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    status = models.CharField(
        max_length=12,
        choices=STATUS_CHOICES,
        default="COMPLETED",
    )
    fault_type = models.CharField(max_length=40, blank=True)

    # Existing timestamps are retained for compatibility.
    created_at = models.DateTimeField(auto_now_add=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    # New event timestamps. Nullable to support existing database records.
    request_received_at = models.DateTimeField(null=True, blank=True)
    sender_debited_at = models.DateTimeField(null=True, blank=True)
    receiver_credited_at = models.DateTimeField(null=True, blank=True)

    def __str__(self):
        return f"{self.transaction_id} · {self.status}"


class TransferEvent(models.Model):
    EVENT_CHOICES = [
        ("REQUEST_RECEIVED", "Request received"),
        ("SENDER_DEBITED", "Sender debited"),
        ("RECEIVER_CREDITED", "Receiver credited"),
        ("TRANSFER_COMPLETED", "Transfer completed"),
        ("TRANSFER_FAILED", "Transfer failed"),
        ("RECOVERY_STARTED", "Recovery started"),
        ("RECOVERY_COMPLETED", "Recovery completed"),
    ]

    transfer = models.ForeignKey(
        Transfer,
        on_delete=models.CASCADE,
        related_name="events",
    )
    event_type = models.CharField(max_length=32, choices=EVENT_CHOICES)
    occurred_at = models.DateTimeField(default=timezone.now, db_index=True)
    details = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["occurred_at", "id"]

    def __str__(self):
        return f"{self.transfer.transaction_id} · {self.event_type}"


class Incident(models.Model):
    STATUS_CHOICES = [
        ("ACTIVE", "Active"),
        ("RECOVERED", "Recovered"),
        ("INVESTIGATING", "Investigating"),
        ("VERIFIED", "Verified"),
    ]
    SEVERITY_CHOICES = [
        ("LOW", "Low"),
        ("MEDIUM", "Medium"),
        ("HIGH", "High"),
        ("CRITICAL", "Critical"),
    ]

    incident_key = models.CharField(max_length=32, unique=True)
    title = models.CharField(max_length=180)
    fault_type = models.CharField(max_length=40)
    description = models.TextField()
    status = models.CharField(
        max_length=16,
        choices=STATUS_CHOICES,
        default="ACTIVE",
    )
    severity = models.CharField(
        max_length=12,
        choices=SEVERITY_CHOICES,
        default="HIGH",
    )
    affected_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="incidents",
    )
    transfer = models.ForeignKey(
        Transfer,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="incidents",
    )
    evidence = models.JSONField(default=list, blank=True)
    hypothesis = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    recovered_at = models.DateTimeField(null=True, blank=True)
    verified_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.incident_key} · {self.title}"
