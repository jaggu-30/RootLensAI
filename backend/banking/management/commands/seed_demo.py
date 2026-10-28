from django.core.management.base import BaseCommand
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from banking.models import Account

class Command(BaseCommand):
    help = "Create PayNova demo users and the RootLens AI admin."
    def handle(self, *args, **options):
        User = get_user_model()
        group, _ = Group.objects.get_or_create(name="RootLens Admin")
        users = [("admin", "RootLensAdmin123!", True, 0)]
        names = ["Aarav Sharma", "Ananya Rao", "Vihaan Patel", "Diya Nair", "Arjun Kumar", "Isha Reddy", "Kabir Singh", "Meera Joshi", "Reyansh Das", "Saanvi Iyer", "Aditya Menon", "Aadhya Shah", "Krishna Verma", "Sara Khan", "Ishaan Gupta", "Myra Shetty", "Dev Malhotra", "Kiara Bose", "Rohan Kulkarni", "Tara Pillai"]
        for i, name in enumerate(names, 1):
            username = "demo_user" if i == 1 else ("demo_user2" if i == 2 else f"member{i:02d}")
            users.append((username, "DemoUser123!", False, 5000 + (i * 375)))
        for i, (username, password, staff, balance) in enumerate(users, 1):
            user, _ = User.objects.get_or_create(username=username, defaults={"is_staff": staff, "is_superuser": staff})
            user.is_staff = staff; user.is_superuser = staff; user.set_password(password); user.first_name = "Admin" if staff else names[i-2] if i > 1 else names[0]; user.save()
            if staff: user.groups.add(group)
            number = "PNADMIN0001" if staff else f"PN{i-1:08d}"
            Account.objects.update_or_create(user=user, defaults={"account_number": number, "balance": balance})
            self.stdout.write(self.style.SUCCESS(f"Ready: {username}"))
        self.stdout.write(self.style.WARNING("Demo only. No real money moves. Change demo passwords before any non-local deployment."))
