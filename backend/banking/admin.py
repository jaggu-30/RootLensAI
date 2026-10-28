from django.contrib import admin
from .models import Account, Transfer, Incident
admin.site.register(Account)
admin.site.register(Transfer)
admin.site.register(Incident)
