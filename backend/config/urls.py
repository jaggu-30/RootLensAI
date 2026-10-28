
from django.contrib import admin
from django.urls import path
from rest_framework_simplejwt.views import TokenRefreshView

from banking.views import (
    LoginView,
    MeView,
    DashboardView,
    TransferView,
    IncidentListView,
    IncidentDetailView,
    IncidentAnalysisView,
    IncidentChatView,
    RecoverIncidentView,
    SimulateFaultView,
    HealthView,
)

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/health/", HealthView.as_view()),
    path("api/login/", LoginView.as_view()),
    path("api/token/refresh/", TokenRefreshView.as_view()),
    path("api/me/", MeView.as_view()),
    path("api/dashboard/", DashboardView.as_view()),
    path("api/transfer/", TransferView.as_view()),
    path("api/faults/simulate/", SimulateFaultView.as_view()),
    path("api/incidents/", IncidentListView.as_view()),
    path("api/incidents/<int:pk>/", IncidentDetailView.as_view()),
    path("api/incidents/<int:pk>/analysis/", IncidentAnalysisView.as_view()),
    path("api/chat/", IncidentChatView.as_view()),
    path("api/incidents/<int:pk>/recover/", RecoverIncidentView.as_view()),
]
