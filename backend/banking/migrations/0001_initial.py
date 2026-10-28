# Generated for the RootLens AI / PayNova local demo.
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = [migrations.swappable_dependency(settings.AUTH_USER_MODEL)]

    operations = [
        migrations.CreateModel(
            name='Account',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('account_number', models.CharField(max_length=20, unique=True)),
                ('balance', models.DecimalField(decimal_places=2, default=1000, max_digits=12)),
                ('user', models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name='bank_account', to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.CreateModel(
            name='Transfer',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('transaction_id', models.CharField(max_length=40, unique=True)),
                ('amount', models.DecimalField(decimal_places=2, max_digits=12)),
                ('status', models.CharField(choices=[('PENDING', 'Pending'), ('COMPLETED', 'Completed'), ('FAILED', 'Failed')], default='COMPLETED', max_length=12)),
                ('fault_type', models.CharField(blank=True, max_length=40)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('completed_at', models.DateTimeField(blank=True, null=True)),
                ('receiver', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='received_transfers', to=settings.AUTH_USER_MODEL)),
                ('sender', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='sent_transfers', to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.CreateModel(
            name='Incident',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('incident_key', models.CharField(max_length=32, unique=True)),
                ('title', models.CharField(max_length=180)),
                ('fault_type', models.CharField(max_length=40)),
                ('description', models.TextField()),
                ('status', models.CharField(choices=[('ACTIVE', 'Active'), ('RECOVERED', 'Recovered'), ('INVESTIGATING', 'Investigating'), ('VERIFIED', 'Verified')], default='ACTIVE', max_length=16)),
                ('severity', models.CharField(choices=[('LOW', 'Low'), ('MEDIUM', 'Medium'), ('HIGH', 'High'), ('CRITICAL', 'Critical')], default='HIGH', max_length=12)),
                ('evidence', models.JSONField(blank=True, default=list)),
                ('hypothesis', models.TextField(blank=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('recovered_at', models.DateTimeField(blank=True, null=True)),
                ('verified_at', models.DateTimeField(blank=True, null=True)),
                ('affected_user', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='incidents', to=settings.AUTH_USER_MODEL)),
                ('transfer', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='incidents', to='banking.transfer')),
            ],
            options={'ordering': ['-created_at']},
        ),
    ]
