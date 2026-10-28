
from rest_framework import serializers
from .models import Account, Transfer, TransferEvent, Incident


class AccountSerializer(serializers.ModelSerializer):
    username = serializers.CharField(source="user.username", read_only=True)
    display_name = serializers.SerializerMethodField()
    phone_number = serializers.SerializerMethodField()

    def get_display_name(self, obj):
        return (
            obj.user.get_full_name()
            or obj.user.username.replace("_", " ")
        ).strip().title()

    def get_phone_number(self, obj):
        return f"+91 90000{obj.user_id:05d}"

    class Meta:
        model = Account
        fields = [
            "username",
            "display_name",
            "account_number",
            "balance",
            "phone_number",
        ]


class TransferEventSerializer(serializers.ModelSerializer):
    event_label = serializers.CharField(
        source="get_event_type_display",
        read_only=True,
    )

    class Meta:
        model = TransferEvent
        fields = [
            "id",
            "event_type",
            "event_label",
            "occurred_at",
            "details",
        ]


class TransferSerializer(serializers.ModelSerializer):
    sender_name = serializers.CharField(
        source="sender.username",
        read_only=True,
    )
    receiver_name = serializers.CharField(
        source="receiver.username",
        read_only=True,
    )
    sender_phone = serializers.SerializerMethodField()
    receiver_phone = serializers.SerializerMethodField()
    amount = serializers.DecimalField(
        max_digits=12,
        decimal_places=2,
        coerce_to_string=False,
    )
    events = TransferEventSerializer(many=True, read_only=True)
    sender_debit_to_receiver_credit_ms = serializers.SerializerMethodField()
    request_to_completion_ms = serializers.SerializerMethodField()

    def get_sender_phone(self, obj):
        return f"+91 90000{obj.sender_id:05d}"

    def get_receiver_phone(self, obj):
        return f"+91 90000{obj.receiver_id:05d}"

    @staticmethod
    def elapsed_ms(start, end):
        if not start or not end:
            return None
        return max(0, round((end - start).total_seconds() * 1000))

    def get_sender_debit_to_receiver_credit_ms(self, obj):
        return self.elapsed_ms(
            obj.sender_debited_at,
            obj.receiver_credited_at,
        )

    def get_request_to_completion_ms(self, obj):
        return self.elapsed_ms(
            obj.request_received_at or obj.created_at,
            obj.completed_at,
        )

    class Meta:
        model = Transfer
        fields = [
            "transaction_id",
            "sender_name",
            "sender_phone",
            "receiver_name",
            "receiver_phone",
            "amount",
            "status",
            "fault_type",
            "created_at",
            "completed_at",
            "request_received_at",
            "sender_debited_at",
            "receiver_credited_at",
            "sender_debit_to_receiver_credit_ms",
            "request_to_completion_ms",
            "events",
        ]


class IncidentSerializer(serializers.ModelSerializer):
    affected_username = serializers.CharField(
        source="affected_user.username",
        read_only=True,
        allow_null=True,
    )
    transfer_id = serializers.CharField(
        source="transfer.transaction_id",
        read_only=True,
        allow_null=True,
    )

    class Meta:
        model = Incident
        fields = [
            "id",
            "incident_key",
            "title",
            "fault_type",
            "description",
            "status",
            "severity",
            "affected_username",
            "transfer_id",
            "evidence",
            "hypothesis",
            "created_at",
            "recovered_at",
            "verified_at",
        ]
